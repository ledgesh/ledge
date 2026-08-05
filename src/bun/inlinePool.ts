// The per-note inline-run shell pool.
//
// One persistent shell per note carries cwd/env across blocks run one after
// another — `cd` in block one, `npm test` in block two — which is the point of
// reusing it. But a shell runs one foreground job at a time, and a command
// written into a busy shell does not queue politely: the tty echoes it straight
// into the running block's output, and the marker parser, which can only go by
// markers, files that echo under the wrong block. So a block started while the
// note's shell is mid-block gets an OVERFLOW shell of its own — spawned for that
// run, torn down when the run ends. Concurrency comes from more shells, never
// from sharing one.
//
// The trade is deliberate: blocks run serially keep the note's cwd/env exactly
// as before, and blocks run concurrently start fresh (the spawn cwd, a clean
// env) with state that dies with the run. The alternative — keeping overflow
// shells alive as a pool — would make "which shell has my cd?" a matter of
// scheduling luck; predictable beats warm here.
//
// Persistent shells are keyed per (note, host): a note that targets several
// machines gets one persistent shell on each, so `cd` in a web1 block still
// carries to the next web1 block while db2's shell keeps its own state. Runs
// that land on a busy shell overflow exactly as before — an overflow shell is
// spawned on the run's own host and dies with the run.
//
// This module holds the policy (which shell a run gets, what dies when) behind
// an injected spawn function, so the whole lifecycle is unit-testable with a
// fake shell; index.ts owns the real PtyProcess and the RPC.
import { LOCAL_HOST } from "../shared/frontmatter";
import { MarkerParser, markerCommand, markerInit } from "./markers";

/** The slice of PtyProcess the pool drives (pty.ts satisfies it structurally). */
export interface InlineShellIO {
  readonly exited: boolean;
  write(data: string | Uint8Array): void;
  drain(): Uint8Array | null;
  resize(cols: number, rows: number): void;
  interrupt(): void;
  close(): void;
}

/**
 * MarkerEvent, widened at "ended": `exitCode: null` is the pool closing out a
 * run whose shell died under it (no prompt, no precmd, no D marker) — there is
 * no status to report, only the fact that it is over.
 */
export type InlineEvent =
  | { type: "began"; blockId: string }
  | { type: "output"; blockId: string; data: Uint8Array }
  | { type: "ended"; blockId: string; exitCode: number | null };

/**
 * How the pool reports: what the shell did, and whose run it was.
 *
 * The client rides beside the event rather than inside it, because it is not
 * something the shell said — it is who asked, which the slot has recorded since
 * runs began belonging to clients. Beside it and REQUIRED, so a new emit site
 * cannot forget: a `runEvent` addressed to nobody in particular would be one
 * client's block output arriving on another client's screen (bun/server.ts).
 */
export type InlineEmit = (ev: InlineEvent, client: string) => void;

interface Slot {
  shell: InlineShellIO;
  parser: MarkerParser;
  // The run this shell is executing, marked at write time. parser.openBlockId
  // lags it (the C marker has to echo back through the pty), and that gap is
  // exactly when a second run must NOT pick this shell.
  activeRun: string | null;
  // Which client asked for that run. Set with activeRun and only read while
  // one is set, so it is exactly as fresh as the id beside it. A persistent
  // shell outlives any single run, so this is whose block it is carrying now
  // rather than whose shell it is: two clients running blocks in one note take
  // turns on the primary and get an overflow shell each when they overlap,
  // which is the same rule that already applied to one client's two blocks.
  // Empty is a client id like any other — the bucket clients with no id of
  // their own share, as they share a layout key (bun/layout.ts).
  client: string;
  // Whether activeRun's start marker has arrived. Everything the shell says
  // before it is the shell itself talking, not the block.
  began: boolean;
  // What it said, held in case it turns out to matter (see SILENT_MS).
  preamble: Uint8Array[];
  preambleLen: number;
  // What we typed into it since, which the tty echoes straight back. Dropped
  // from the front of the preamble so a surfaced shell shows what IT said.
  echo: string;
  // When activeRun was written, and whether its preamble has been surfaced.
  startedAt: number;
  spoke: boolean;
  // Cancel arrived for a run that never began: close it out and discard the
  // shell (see cancel).
  abandoned: boolean;
}

/**
 * How long a run may produce no start marker before the shell's own output is
 * shown in its place.
 *
 * Normally nothing outside a C..D pair belongs to any block: it is the prompt,
 * and the tty's echo of what we typed, and the panel is better without it. But
 * a shell that never reaches the block has usually said exactly why, and only
 * there. A remote shell is ssh, and ssh talks before the shell exists: an
 * unknown host key, a passphrase, a 2FA challenge, `Permission denied`. Held
 * back, those turn the first run against a new host into a block that runs
 * forever with an empty panel.
 *
 * Long enough that no healthy connection reaches it, so the noise stays out of
 * the ordinary case; short enough to answer a prompt that is waiting on you.
 * Past it the shell streams straight to the panel, which already takes
 * keystrokes, so a question can be answered where it is asked.
 */
const SILENT_MS = 4000;

/** How much of a silent shell's output is worth keeping. A banner is small; a
 * shell stuck in a loop is not, and only its tail says anything. */
const PREAMBLE_CAP = 16 * 1024;

/**
 * Drop the tty's echo of `typed` from the front of `data`, so what a surfaced
 * shell shows is what the SHELL said and not the marker hook being installed.
 *
 * Only an exact, complete match is dropped: half a match means the echo is
 * still arriving or came back mangled, and guessing there would eat the first
 * line of the real message. Carriage returns are skipped on the way, since the
 * tty inserts them at the wrap column and after every newline, and neither is
 * anything we typed.
 */
export function stripEcho(data: Uint8Array, typed: string): Uint8Array {
  let i = 0;
  let j = 0;
  while (i < data.length && j < typed.length) {
    if (data[i] === 0x0d) {
      i++;
      continue;
    }
    if (data[i] !== typed.charCodeAt(j)) break;
    i++;
    j++;
  }
  if (j < typed.length) return data;
  while (i < data.length && (data[i] === 0x0d || data[i] === 0x0a)) i++;
  return data.subarray(i);
}

interface Session {
  // The note's persistent shells, one per host it has run on ("local" for the
  // machine Ledge runs on). An entry disappears when its shell dies (a block
  // ran `exit`) and is respawned by that host's next run.
  primaries: Map<string, Slot>;
  // Overflow shells keyed by the run they were spawned for; they die with it.
  overflow: Map<string, Slot>;
}

export class InlinePool {
  private readonly sessions = new Map<string, Session>();
  // Grids reported for runs Bun has not seen yet: the output panel fits itself
  // the moment it renders, and that resize can beat runBlock across the RPC.
  // Applied (and dropped) when the run picks its shell.
  private readonly pendingResize = new Map<string, { sessionId: string; cols: number; rows: number }>();

  // `spawn` takes the session id and host so the shell can be born with that
  // note's params (cwd/env from its frontmatter) on the machine the run named:
  // the pool decides WHEN a shell spawns, but whose note it belongs to and
  // where it lives is information only the caller's spawn can act on.
  // `now` is injectable so the silence rule is testable without waiting on a
  // clock; nothing else in here has a sense of time.
  constructor(
    private readonly spawn: (sessionId: string, host: string) => InlineShellIO,
    private readonly nonce: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Start `runner` for run `id`, on the note's shell for `by.host` or a fresh
   * overflow one.
   *
   * `by.client` is required rather than defaulted because the unsafe value is
   * the plausible one: a caller that forgot would file every run under one
   * bucket, and `claim` would then find nothing of anyone's to collect. An
   * options object rather than two more positional strings, since a client id
   * and an ssh destination are both bare strings and nothing at a call site
   * would catch them the wrong way round.
   */
  run(sessionId: string, id: string, runner: string, by: { client: string; host?: string }): void {
    const host = by.host ?? LOCAL_HOST;
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { primaries: new Map(), overflow: new Map() };
      this.sessions.set(sessionId, session);
    }
    let slot = session.primaries.get(host);
    if (!slot) {
      slot = this.newSlot(sessionId, host);
      session.primaries.set(host, slot);
    }
    if (slot.activeRun !== null) {
      slot = this.newSlot(sessionId, host);
      session.overflow.set(id, slot);
    }
    slot.activeRun = id;
    slot.client = by.client;
    slot.began = false;
    slot.spoke = false;
    slot.preamble = [];
    slot.preambleLen = 0;
    slot.startedAt = this.now();
    slot.abandoned = false;
    const size = this.pendingResize.get(id);
    if (size) {
      this.pendingResize.delete(id);
      slot.shell.resize(size.cols, size.rows);
    }
    const line = markerCommand(runner, this.nonce, id);
    slot.echo += line;
    slot.shell.write(line);
  }

  /**
   * SIGINT whatever run `id`'s shell is running, as ^C would.
   *
   * A run that never began is a different thing to stop. Its command line went
   * into a shell that was not listening for one — ssh reading it as the answer
   * to a host-key question is how that happens — so there is no job to signal,
   * no marker will ever close the run, and the block would sit on "Running"
   * with a dead button forever. Stop ends it and discards the shell, whose
   * state nobody can now describe; the next run spawns a fresh one, which by
   * then is a connection to a host ssh has been told to trust.
   */
  cancel(sessionId: string, id: string): void {
    const slot = this.slotFor(sessionId, id);
    if (slot) this.interrupt(slot);
  }

  /**
   * Line the pool up with the runs a client can still show: interrupt every run
   * `keep` does not name, and answer which of `keep` is actually running.
   *
   * A run is only ever stopped by the panel that shows it (`cancel` above), and
   * a client that reloaded has no panels: its runs would keep going with nothing
   * on screen to see them, nothing able to stop them (the ids went with the old
   * page), and the server held alive underneath. So the client says what it
   * still has and this collects the difference — the same interrupt, for the
   * same reason, reaching the runs whose panel went away without a click.
   *
   * Scoped to `client`, because an unclaimed run is an orphan only to the
   * client that started it. Another client's runs are not this one's to
   * collect: it cannot show them, cannot stop them, and was never told about
   * them, so silence about them is the whole of what it has to say. Without
   * the scope a phone finishing its boot interrupts the build a Mac is
   * watching, and the only trace is a line in the server's log.
   *
   * What the scope does NOT do is collect a run whose client never comes back.
   * That was never this method's job — nobody's boot arrives to ask — and it
   * is the daemon's idle exit that ends it, which already waits on `running`.
   */
  claim(client: string, keep: readonly string[]): { running: string[]; orphaned: string[] } {
    const wanted = new Set(keep);
    const running: string[] = [];
    const orphaned: string[] = [];
    for (const session of this.sessions.values()) {
      for (const slot of this.slots(session)) {
        if (slot.client !== client) continue;
        // activeRun first: it is set at write time, and the parser's view of
        // the same run lags it by one echo (see Slot).
        const id = slot.activeRun ?? slot.parser.openBlockId;
        if (id === null) continue;
        if (wanted.has(id)) {
          running.push(id);
          continue;
        }
        orphaned.push(id);
        this.interrupt(slot);
      }
    }
    return { running, orphaned };
  }

  /** Keystrokes / pasted text for the program run `id` is executing. */
  input(sessionId: string, id: string, data: Uint8Array): void {
    this.slotFor(sessionId, id)?.shell.write(data);
  }

  /** Match run `id`'s shell winsize to its rendered grid (stashed if pre-run). */
  resize(sessionId: string, id: string, cols: number, rows: number): void {
    const slot = this.slotFor(sessionId, id);
    if (slot) slot.shell.resize(cols, rows);
    else this.pendingResize.set(id, { sessionId, cols, rows });
  }

  /**
   * Drain every shell, emitting per-run events. Also where lifecycle turns:
   * an overflow shell is closed when its run ends, and a dead shell (its block
   * ran `exit`, or it was killed) has its open run closed out by hand — nobody
   * else can now, and a panel left on "Running" would disable that block's run
   * button for good.
   */
  drain(emit: InlineEmit): void {
    for (const [sessionId, session] of [...this.sessions]) {
      for (const slot of this.slots(session)) {
        const data = slot.shell.drain();
        if (data) {
          // Anything arriving before the run's start marker: kept, or shown, by
          // the rules in SILENT_MS. The parser would drop it, and it is the
          // only account a stuck shell ever gives of itself.
          if (slot.activeRun !== null && !slot.began) this.holdOrShow(slot, data, emit);
          for (const ev of slot.parser.feed(data)) {
            if (ev.type === "began" && ev.blockId === slot.activeRun) {
              // The block is running: its own output starts here, and the
              // prologue was what it always is, the echo of what we typed.
              slot.began = true;
              slot.preamble = [];
              slot.preambleLen = 0;
              slot.echo = "";
            }
            emit(ev, slot.client);
            if (ev.type === "ended") this.runEnded(session, slot, ev.blockId);
          }
        }
        // Silent too long: hand over what the shell has said, and keep handing
        // it over, so a question waiting for an answer can be answered.
        if (slot.activeRun !== null && !slot.began && !slot.spoke && this.now() - slot.startedAt >= SILENT_MS) {
          slot.spoke = true;
          this.flushPreamble(slot, emit);
        }
        // Stopped before it ever started (see cancel): the shell cannot close
        // this run and nothing else will, so the pool does, and the shell goes
        // with it rather than serving the next block from an unknown state.
        if (slot.abandoned && !slot.began && slot.activeRun !== null) {
          this.flushPreamble(slot, emit);
          emit({ type: "ended", blockId: slot.activeRun, exitCode: null }, slot.client);
          this.dropSlot(session, slot);
          continue;
        }
        if (slot.shell.exited) {
          // activeRun as the fallback: the shell can die after the command was
          // written but before its C marker echoed back.
          const open = slot.parser.openBlockId ?? slot.activeRun;
          // A shell that died before its block began took the reason with it
          // ("Host key verification failed", "Permission denied"), so say it
          // even if the silence rule has not fired yet.
          if (open && !slot.began) this.flushPreamble(slot, emit);
          if (open) emit({ type: "ended", blockId: open, exitCode: null }, slot.client);
          this.dropSlot(session, slot);
        }
      }
      if (session.primaries.size === 0 && session.overflow.size === 0) this.sessions.delete(sessionId);
    }
  }

  /**
   * Kill all of a note's inline shells so its next run spawns fresh ones (with
   * the note's current params). Unlike closeSession the tab is still open and
   * watching: every open run must be closed out through `emit`, or its panel
   * sits on "Running" and its run button stays dead — the same debt the drain
   * loop pays when a shell dies on its own.
   */
  restartSession(sessionId: string, emit: InlineEmit): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const slot of this.slots(session)) {
        const open = slot.parser.openBlockId ?? slot.activeRun;
        if (open) emit({ type: "ended", blockId: open, exitCode: null }, slot.client);
        slot.shell.close();
      }
      this.sessions.delete(sessionId);
    }
    for (const [id, p] of this.pendingResize) {
      if (p.sessionId === sessionId) this.pendingResize.delete(id);
    }
  }

  /** Tear down all of a note's inline shells; its tab closed. */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const slot of this.slots(session)) slot.shell.close();
      this.sessions.delete(sessionId);
    }
    for (const [id, p] of this.pendingResize) {
      if (p.sessionId === sessionId) this.pendingResize.delete(id);
    }
  }

  /** Whether any block is mid-run. What the daemon asks before deciding a
   * client that went away can be allowed to take the server with it: a block
   * still running is the whole reason a server outlives its connection
   * (remote.md §7). An idle shell is worth nothing to a client that said
   * nothing, and worth keeping for one that declared a hold, which is what
   * `sessionsOpen` below answers instead. */
  running(): boolean {
    for (const session of this.sessions.values()) {
      for (const slot of this.slots(session)) {
        if (slot.activeRun !== null || slot.parser.openBlockId !== null) return true;
      }
    }
    return false;
  }

  /**
   * Whether any note has an inline shell at all, running or sitting idle.
   *
   * What a session hold is FOR: a note's shell keeps the cwd it was `cd`'d to
   * and whatever the last block exported, so a client coming back to it is
   * coming back to state nothing else can rebuild. A server with none of these
   * has nothing to hold, however long its client asked for (daemon.ts).
   */
  sessionsOpen(): boolean {
    return this.sessions.size > 0;
  }

  /** Process exit: close every shell of every note. */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      for (const slot of this.slots(session)) slot.shell.close();
    }
    this.sessions.clear();
    this.pendingResize.clear();
  }

  // Pre-marker bytes: straight to the panel once the slot has started
  // reporting, held (up to a cap) while it might still be ordinary noise. The
  // cap is a bound on a shell that chatters forever without ever starting the
  // block; what matters in that stream is the last thing said, so the oldest
  // chunk goes first.
  private holdOrShow(slot: Slot, data: Uint8Array, emit: InlineEmit): void {
    if (slot.spoke) {
      emit({ type: "output", blockId: slot.activeRun!, data }, slot.client);
      return;
    }
    slot.preamble.push(data);
    slot.preambleLen += data.length;
    while (slot.preambleLen > PREAMBLE_CAP && slot.preamble.length > 1) {
      slot.preambleLen -= slot.preamble.shift()!.length;
    }
  }

  private flushPreamble(slot: Slot, emit: InlineEmit): void {
    if (slot.activeRun === null || slot.preambleLen === 0) return;
    const joined = new Uint8Array(slot.preambleLen);
    let off = 0;
    for (const c of slot.preamble) {
      joined.set(c, off);
      off += c.length;
    }
    slot.preamble = [];
    slot.preambleLen = 0;
    const out = stripEcho(joined, slot.echo);
    if (out.length > 0) emit({ type: "output", blockId: slot.activeRun, data: out }, slot.client);
  }

  private newSlot(sessionId: string, host: string): Slot {
    const shell = this.spawn(sessionId, host);
    // Install the end-marker hook before any block can run. Its own echo lands
    // outside every C..D pair, so the parser drops it and no block ever sees it.
    const init = markerInit(this.nonce);
    shell.write(init);
    return {
      shell,
      parser: new MarkerParser(this.nonce),
      activeRun: null,
      client: "",
      began: false,
      preamble: [],
      preambleLen: 0,
      echo: init,
      startedAt: 0,
      spoke: false,
      abandoned: false,
    };
  }

  private slots(session: Session): Slot[] {
    return [...session.primaries.values(), ...session.overflow.values()];
  }

  // Stop what a slot is running, by whichever of the two routes applies: a
  // signal for a run that began, and the abandoned flag for one that never did.
  // `cancel` states why they differ; `claim` needs the same pair.
  private interrupt(slot: Slot): void {
    slot.shell.interrupt();
    if (!slot.began) slot.abandoned = true;
  }

  private slotFor(sessionId: string, id: string): Slot | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    for (const slot of session.primaries.values()) if (slot.activeRun === id) return slot;
    return session.overflow.get(id);
  }

  // A run reached its D marker: free its shell, or retire it. A persistent
  // shell survives to carry cwd/env to its host's next block; an overflow
  // shell has no next block — nothing can ever be routed to it again — so
  // keeping it would only leak a shell (and, remotely, an ssh connection).
  private runEnded(session: Session, slot: Slot, id: string): void {
    if (slot.activeRun === id) slot.activeRun = null;
    if (session.overflow.get(id) === slot) {
      slot.shell.close();
      session.overflow.delete(id);
    }
  }

  private dropSlot(session: Session, slot: Slot): void {
    slot.shell.close();
    for (const [host, s] of session.primaries) {
      if (s === slot) {
        session.primaries.delete(host);
        return;
      }
    }
    for (const [id, s] of session.overflow) {
      if (s === slot) session.overflow.delete(id);
    }
  }
}
