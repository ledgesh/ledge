// Slices the PTY byte stream into per-block output using OSC 133 semantic
// markers. A faithful TypeScript port of Sources/SessionKit/MarkerProtocol.swift.
//
// Everything in a note flows through one shell on one PTY, so the byte stream is
// a single mixed torrent: prompts, the shell's echo of what we typed, and the
// actual output of each block. We wrap every submitted command in OSC 133 begin
// (C) and end (D) markers and keep only the bytes between a C and its matching D.

const ESC = 0x1b;
const BEL = 0x07;
// ESC ] 1 3 3 ;
const OSC_PREFIX = new Uint8Array([0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b]);

export type MarkerEvent =
  | { type: "began"; blockId: string }
  | { type: "output"; blockId: string; data: Uint8Array }
  | { type: "ended"; blockId: string; exitCode: number };

/**
 * Install the end-marker hook. Sent once, when a note's inline shell is spawned,
 * before any block runs.
 *
 * The end marker cannot be the next command on the block's line. Ctrl-C aborts the
 * whole line, so the printf reporting the exit code never runs and the block reads
 * as still Running forever - which is precisely what you get for interrupting it.
 * zsh's `always` block does not survive the interrupt either.
 *
 * precmd runs before every prompt, and the shell prints a prompt however the line
 * ended: finished, failed, or interrupted. So the end marker is reported from
 * there, with $? carrying the real status (130 for a SIGINT).
 *
 * `local rc=$?` must be the first thing in the function or the status is lost.
 * `__ledge_id` is cleared after reporting, so the hook stays silent for prompts
 * that follow anything other than a block.
 *
 * The line is written blind into whatever shell the pool spawned, and since
 * remote hosts came along that is not always zsh: a remote inline shell is
 * `bash -l` (bash is the one shell ~every server has; see bun/remoteSpawn.ts).
 * So the function body is POSIX (`[ ]`, explicit `;` before `}`) and only the
 * hook registration branches: zsh's precmd_functions, else bash's
 * PROMPT_COMMAND (prepended — both run before every prompt). Anything else
 * (fish, ash) never receives this line, because the pool only ever spawns
 * zsh (local, settings.shell) or bash (remote).
 *
 * PROMPT_SP goes with it, on the zsh side. That option makes zsh emit its
 * PROMPT_EOL_MARK (a reverse-video `%`) padded with spaces and a carriage
 * return before every prompt, so a human can see when output ended mid-line.
 * Two reasons it has no business here: nobody ever sees this shell's prompt
 * (the pool keeps only the bytes between the C and D markers, and the mark is
 * emitted BEFORE precmd, so it lands inside that window), and the erase half
 * of the trick is sized to the pty's winsize — when that disagrees with the
 * grid the panel actually renders, the padding wraps, the carriage return
 * lands on the wrong row, and the `%` survives as a stray line under every
 * block's output. The drawer's shell is a different shell and keeps the
 * option: there the prompt IS the point.
 */
export function markerInit(nonce: string): string {
  return (
    `__ledge_precmd() { local rc=$?; [ -n "$__ledge_id" ] || return; ` +
    `printf '\\033]133;D;%d;ledge=${nonce}:%s\\a' "$rc" "$__ledge_id"; __ledge_id=; }; ` +
    `if [ -n "$ZSH_VERSION" ]; then unsetopt PROMPT_SP; precmd_functions+=(__ledge_precmd); ` +
    `else PROMPT_COMMAND="__ledge_precmd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"; fi\n`
  );
}

/**
 * Build the line submitted to the shell for one block: name the block, mark its
 * start, run it. The end marker comes from the precmd hook above.
 */
export function markerCommand(runner: string, nonce: string, blockId: string): string {
  return (
    `__ledge_id=${blockId}; printf '\\033]133;C;ledge=${nonce}:${blockId}\\a'; ${runner}\n`
  );
}

type Parsed =
  | { kind: "began"; id: string }
  | { kind: "ended"; id: string; code: number }
  | { kind: "unknown" };

export class MarkerParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private openBlock: string | null = null;

  /**
   * The block whose start marker we have seen but whose end marker we have not, if
   * any. Only the shell can normally close a block; this is for when the shell is
   * gone and someone else has to say so.
   */
  get openBlockId(): string | null {
    return this.openBlock;
  }

  constructor(private readonly nonce: string) {}

  /** Feed bytes from the PTY. Returns whatever became unambiguous. */
  feed(data: Uint8Array): MarkerEvent[] {
    this.buffer = concat(this.buffer, data);
    const events: MarkerEvent[] = [];

    while (this.buffer.length > 0) {
      const start = this.firstOSC(this.buffer);
      if (start === -1) {
        // No marker ahead. Everything we hold is output or noise, except a
        // possible partial escape at the very end (keep it for the next read).
        const safe = this.buffer.length - this.partialOSCSuffixLength(this.buffer);
        if (safe > 0) {
          this.emit(this.buffer.subarray(0, safe), events);
          this.buffer = this.buffer.subarray(safe);
        }
        break;
      }

      if (start > 0) {
        this.emit(this.buffer.subarray(0, start), events);
        this.buffer = this.buffer.subarray(start);
      }

      const parsed = this.parseMarker(this.buffer);
      if (!parsed) break; // marker still arriving

      const [marker, consumed] = parsed;
      this.buffer = this.buffer.subarray(consumed);
      if (marker.kind === "began") {
        this.openBlock = marker.id;
        events.push({ type: "began", blockId: marker.id });
      } else if (marker.kind === "ended") {
        if (this.openBlock === marker.id) this.openBlock = null;
        events.push({ type: "ended", blockId: marker.id, exitCode: marker.code });
      }
      // unknown: some other OSC 133 sequence, not ours, not output.
    }

    return events;
  }

  private emit(bytes: Uint8Array, events: MarkerEvent[]): void {
    // Output outside a block is prompt noise or the shell's echo. Drop it.
    if (!this.openBlock || bytes.length === 0) return;
    events.push({ type: "output", blockId: this.openBlock, data: bytes.slice() });
  }

  private firstOSC(data: Uint8Array): number {
    if (data.length < OSC_PREFIX.length) return data.indexOf(ESC);
    return indexOfSeq(data, OSC_PREFIX);
  }

  /** Trailing bytes that might be the start of a marker we haven't fully got. */
  private partialOSCSuffixLength(data: Uint8Array): number {
    const maxPartial = Math.min(OSC_PREFIX.length - 1, data.length);
    for (let len = maxPartial; len >= 1; len--) {
      let match = true;
      for (let i = 0; i < len; i++) {
        if (data[data.length - len + i] !== OSC_PREFIX[i]) {
          match = false;
          break;
        }
      }
      if (match) return len;
    }
    return 0;
  }

  /** Parse a marker at the head of `data`. Returns null if incomplete. */
  private parseMarker(data: Uint8Array): [Parsed, number] | null {
    if (!startsWith(data, OSC_PREFIX)) {
      // Buffer begins with ESC but not yet the whole prefix. If it's a leading
      // slice of our prefix, the rest is in flight: wait.
      if (data.length < OSC_PREFIX.length && startsWith(OSC_PREFIX, data)) return null;
      // A real ESC that is not our OSC 133. Skip one byte, treat as noise.
      return [{ kind: "unknown" }, 1];
    }

    const bodyStart = OSC_PREFIX.length;
    let end = -1;
    let terminatorLength = 0;

    const bel = data.indexOf(BEL, bodyStart);
    if (bel !== -1) {
      end = bel;
      terminatorLength = 1;
    }
    // ESC \ (ST) is the other legal terminator.
    for (let i = bodyStart; i < data.length - 1; i++) {
      if (data[i] === ESC && data[i + 1] === 0x5c) {
        if (end === -1 || i < end) {
          end = i;
          terminatorLength = 2;
        }
        break;
      }
    }
    if (end === -1) return null;

    const body = new TextDecoder().decode(data.subarray(bodyStart, end));
    const consumed = end + terminatorLength;
    const fields = body.split(";");
    const kind = fields[0];

    if (kind === "C" && fields.length >= 2) {
      const id = this.blockId(fields[1]);
      if (id !== null) return [{ kind: "began", id }, consumed];
    }
    if (kind === "D" && fields.length >= 3) {
      const code = parseInt(fields[1], 10);
      const id = this.blockId(fields[2]);
      if (!Number.isNaN(code) && id !== null) return [{ kind: "ended", id, code }, consumed];
    }
    return [{ kind: "unknown" }, consumed];
  }

  /** Pull the block id out of `ledge=<nonce>:<block>`, only if the nonce is ours. */
  private blockId(tag: string): string | null {
    if (!tag.startsWith("ledge=")) return null;
    const payload = tag.slice("ledge=".length);
    const sep = payload.indexOf(":");
    if (sep === -1) return null;
    if (payload.slice(0, sep) !== this.nonce) return null;
    return payload.slice(sep + 1);
  }
}

// --- byte helpers ---

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

function indexOfSeq(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
