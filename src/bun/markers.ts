// Slices the PTY byte stream into per-block output using OSC 133 semantic
// markers. A faithful TypeScript port of
// Sources/SessionKit/MarkerProtocol.swift.
//
// Everything in a note flows through one shell on one PTY, so the byte stream
// mixes three things: prompts, the shell's echo of the submitted line, and the
// output of each block. `markerCommand` marks the start of each submitted
// command with an OSC 133 C, and the hook `markerInit` installs marks its end
// with a D. `MarkerParser` keeps only the bytes between a C and its matching D.

const ESC = 0x1b;
const BEL = 0x07;
// ESC ] 1 3 3 ;
const OSC_PREFIX = new Uint8Array([0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b]);

export type MarkerEvent =
  | { type: "began"; blockId: string }
  | { type: "output"; blockId: string; data: Uint8Array }
  | { type: "ended"; blockId: string; exitCode: number }
  // The init line's acknowledgement: this shell can now end a block. It
  // carries no id because it is about the shell, not about a run. See
  // markerInit for what a shell that never sends it costs.
  | { type: "ready" };

/**
 * Install the end-marker hook. `inlinePool.ts` prepends this line to a block's
 * own line, and does so for every block until the shell acknowledges the hook.
 * It used to be written on its own at spawn, which made it the likeliest thing
 * in the system to be lost, silently and completely (architecture.md §6a, the
 * end-marker hook bullet, has the pty write window and the damage).
 *
 * The end marker cannot be the next command on the block's line. Ctrl-C aborts
 * the whole line, so the printf reporting the exit code never runs and the
 * block reads as Running forever. zsh's `always` block does not survive the
 * interrupt either.
 *
 * precmd runs before every prompt, and the shell prints a prompt however the
 * line ended: finished, failed, or interrupted. So the end marker is reported
 * from there, with $? carrying the real status (130 for a SIGINT).
 *
 * `local rc=$?` must be the first thing in the function or the status is lost.
 * `__ledge_id` is cleared after reporting, so the hook stays silent for prompts
 * that follow anything other than a block.
 *
 * The line is written blind into whatever shell the pool spawned, and that is
 * not always zsh. A remote inline shell is `bash -l`, bash being the one shell
 * ~every server has (bun/remoteSpawn.ts). So the function body is POSIX (`[ ]`,
 * explicit `;` before `}`). Only the hook registration branches: zsh registers
 * through precmd_functions, bash through PROMPT_COMMAND (prepended), and both
 * run before every prompt. A configured shell that is neither, such as fish,
 * still spawns and still gets this line. It registers nothing and never ends a
 * block, which `shellCaveat` (bun/spawnParams.ts) warns about.
 *
 * `unsetopt PROMPT_SP` goes with it, on the zsh side. PROMPT_SP prints zsh's
 * PROMPT_EOL_MARK (a reverse-video `%`) before every prompt, padded with spaces
 * and a carriage return that erase it again, so a person can see when output
 * ended mid-line. The mark is emitted ahead of precmd, so it lands inside the
 * C..D window the pool keeps. The padding is sized to the pty's winsize: when
 * that disagrees with the grid the panel renders, the padding wraps, the
 * carriage return lands on the wrong row, and the `%` is left as a stray line
 * under every block's output. The terminal drawer spawns its own shell, which
 * never gets this line and keeps the option, because the user reads that
 * shell's prompt.
 *
 * The leading newline covers the cheapest damage, a lost first byte. What is
 * left of the line is an empty command, and the definition starts on the next
 * one. Without it, one byte short produces no error at all: `_ledge_precmd()
 * {…}` next to a `precmd_functions+=(__ledge_precmd)` naming a function that
 * does not exist. Found on a Linux server (scripts/probe-ssh.ts), where it was
 * every inline run.
 *
 * The `R` printf is last, so a shell that prints it ran everything before it.
 * A shell that never sends it can never end a block, and architecture.md §6a
 * has what that leaves in the panel. `inlinePool.ts` reads the ack and re-sends
 * the hook before the next block rather than trusting one write.
 */
export function markerInit(nonce: string): string {
  return (
    `\n__ledge_precmd() { local rc=$?; [ -n "$__ledge_id" ] || return; ` +
    `printf '\\033]133;D;%d;ledge=${nonce}:%s\\a' "$rc" "$__ledge_id"; __ledge_id=; }; ` +
    `if [ -n "$ZSH_VERSION" ]; then unsetopt PROMPT_SP; precmd_functions+=(__ledge_precmd); ` +
    `else PROMPT_COMMAND="__ledge_precmd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"; fi; ` +
    `printf '\\033]133;R;ledge=${nonce}\\a'\n`
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
  | { kind: "ready" }
  | { kind: "unknown" };

export class MarkerParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private openBlock: string | null = null;

  /**
   * The block whose start marker has arrived and whose end marker has not, or
   * null. The shell normally closes a block. This names the block for a caller
   * that has to account for it instead: `inlinePool.ts` ends a block whose
   * shell exited or whose session restarted, interrupts an orphaned run, and
   * answers whether any block is mid-run.
   */
  get openBlockId(): string | null {
    return this.openBlock;
  }

  constructor(private readonly nonce: string) {}

  /** Feed bytes from the PTY. Returns the events they produce. */
  feed(data: Uint8Array): MarkerEvent[] {
    this.buffer = concat(this.buffer, data);
    const events: MarkerEvent[] = [];

    while (this.buffer.length > 0) {
      const start = this.firstOSC(this.buffer);
      if (start === -1) {
        // No marker ahead. The whole buffer is output or noise, except a
        // partial escape sequence at the end, kept for the next read.
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
      } else if (marker.kind === "ready") {
        events.push({ type: "ready" });
      }
      // unknown: a stray ESC, or an OSC 133 sequence this parser does not
      // accept (another program's, or one that fails the nonce or field
      // checks). Consumed either way, never emitted as output.
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

  /** How many trailing bytes could be the start of a marker still arriving. */
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
      // The buffer begins with ESC but not with the whole prefix. A leading
      // slice of the prefix means the rest is still arriving: wait for it.
      if (data.length < OSC_PREFIX.length && startsWith(OSC_PREFIX, data)) return null;
      // A real ESC that is not this OSC 133 prefix. Skip one byte as noise.
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
    // No block id and no status: the whole payload is the nonce, so a shell
    // that does not know the nonce cannot claim to have installed the hook.
    if (kind === "R" && fields.length >= 2 && fields[1] === `ledge=${this.nonce}`) {
      return [{ kind: "ready" }, consumed];
    }
    if (kind === "D" && fields.length >= 3) {
      const code = parseInt(fields[1], 10);
      const id = this.blockId(fields[2]);
      if (!Number.isNaN(code) && id !== null) return [{ kind: "ended", id, code }, consumed];
    }
    return [{ kind: "unknown" }, consumed];
  }

  /** Pull the block id out of `ledge=<nonce>:<block>`, if the nonce matches. */
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
