// The per-note inline-run shell pool.
//
// One persistent shell per note carries cwd and env across blocks run one
// after another. Carrying that state is why the shell is reused: `cd` in block
// one, `npm test` in block two. A shell runs one foreground job at a time, and
// a command written into a busy shell does not queue. The tty echoes it into
// the running block's output, and the marker parser can only go by markers, so
// it files that echo under the wrong block. A block started while the note's
// shell is mid-block gets an overflow shell of its own, spawned for that run
// and torn down when the run ends.
//
// Blocks run serially keep the note's cwd and env exactly as before. Blocks
// run concurrently start fresh (the spawn cwd, a clean env) with state that
// ends with the run. Keeping overflow shells alive as a pool would instead
// make which shell holds a given `cd` depend on scheduling.
//
// Persistent shells are keyed per (note, host). A note that targets several
// machines gets one persistent shell on each, so `cd` in a web1 block still
// carries to the next web1 block while db2's shell keeps its own state. Runs
// that land on a busy shell overflow exactly as before: the overflow shell is
// spawned on the run's own host and dies with the run.
//
// This module holds the policy (which shell a run gets, what dies when)
// behind an injected spawn function, so the whole lifecycle is unit-testable
// with a fake shell. server.ts owns the real PtyProcess and the RPC.
import { LOCAL_HOST } from "../shared/frontmatter";
import { MarkerParser, markerCommand, markerInit } from "./markers";

/** The slice of PtyProcess the pool drives (pty.ts satisfies it structurally). */
export interface InlineShellIO {
  readonly exited: boolean;
  /** Input still queued for the tty, if the shell tracks it (pty.ts does).
   * Optional because it is a hint for whoever schedules `drain` rather than
   * anything this pool's policy reads. The drain loop slows down on a shell
   * that leaves it undefined. */
  readonly pending?: boolean;
  write(data: string | Uint8Array): void;
  drain(): Uint8Array | null;
  resize(cols: number, rows: number): void;
  interrupt(): void;
  close(): void;
}

/**
 * MarkerEvent, widened at "ended". `exitCode: null` is the pool closing out a
 * run whose shell died under it: no prompt, no precmd, no D marker, so there
 * is no status to report, only that the run is over.
 */
export type InlineEvent =
  | { type: "began"; blockId: string }
  | { type: "output"; blockId: string; data: Uint8Array }
  | { type: "ended"; blockId: string; exitCode: number | null };

/**
 * How the pool reports: what the shell did, and whose run it was.
 *
 * The client rides beside the event rather than inside it, because it is not
 * something the shell said. It is who asked for the run, which the slot
 * records. It is required rather than optional so a new emit site cannot omit
 * it: an unaddressed `runEvent` would put one client's block output on another
 * client's screen (bun/server.ts).
 */
export type InlineEmit = (ev: InlineEvent, client: string) => void;

interface Slot {
  shell: InlineShellIO;
  parser: MarkerParser;
  // The run this shell is executing, marked at write time. parser.openBlockId
  // lags it (the C marker has to echo back through the pty), and a second run
  // must not pick this shell during that gap.
  activeRun: string | null;
  // Which client asked for that run. Set with activeRun and read only while
  // one is set, so it is as fresh as the id beside it. A persistent shell
  // outlives any one run, so this is whose block it carries now rather than
  // whose shell it is: two clients in one note take turns on the primary and
  // get an overflow shell each when they overlap, as one client's two blocks
  // do. Empty is a client id like any other, the bucket shared by clients with
  // no id of their own, as they share a layout key (bun/layout.ts).
  client: string;
  // Whether activeRun's start marker has arrived. Everything the shell says
  // before it is the shell itself talking, not the block.
  began: boolean;
  // What the shell said before then, held in case it matters (see SILENT_MS).
  preamble: Uint8Array[];
  preambleLen: number;
  // What the pool typed into it since, which the tty echoes straight back.
  // Dropped from the front of the preamble so a surfaced shell shows its own
  // output.
  echo: string;
  // When activeRun was written, and whether its preamble has been surfaced.
  startedAt: number;
  spoke: boolean;
  // Cancel arrived for a run that never began: close it out and discard the
  // shell (see cancel).
  abandoned: boolean;
  // Whether this shell has acknowledged the end-marker hook (markers.ts `R`).
  // False means either that the init line is still in flight or that it never
  // landed, and the pool cannot tell those apart. Both get the same answer:
  // send it again with the next block. The hook is idempotent, and a shell
  // without it begins blocks it can never end.
  hooked: boolean;
}

/**
 * How long a run may produce no start marker before the shell's own output is
 * shown in its place.
 *
 * Normally nothing outside a C..D pair belongs to any block: it is the prompt
 * and the tty's echo of what was typed, and the panel is better without it. A
 * shell that never reaches the block has usually said why, and only in the
 * bytes before the start marker. A remote shell is ssh, and ssh talks before
 * the shell exists: an unknown host key, a passphrase, a 2FA challenge,
 * `Permission denied`. Held back, those turn the first run against a new host
 * into a block that runs forever with an empty panel.
 *
 * The value is long enough that a healthy connection never reaches it, so the
 * noise stays out of the ordinary case. It is short enough to answer a prompt
 * that is waiting. Past it the shell streams straight to the panel, which
 * already takes keystrokes, so a question can be answered where it is asked.
 */
const SILENT_MS = 4000;

/** How much of a silent shell's output is kept. A banner is small. A shell
 * stuck in a loop is not, and only the tail of that output is informative. */
const PREAMBLE_CAP = 16 * 1024;

/**
 * Drop the tty's echo of `typed` from the front of `data`, so a surfaced shell
 * shows its own output rather than the marker hook being installed.
 *
 * Only an exact, complete match is dropped. Half a match means the echo is
 * still arriving or came back mangled, and guessing there would eat the first
 * line of the real message. Carriage returns are skipped on the way, because
 * the tty inserts them at the wrap column and after every newline, and neither
 * is part of what was typed.
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

  // `spawn` takes the session id and host so the shell starts with that note's
  // params (cwd and env from its frontmatter) on the machine the run named.
  // The pool decides when a shell spawns, and only the caller's spawn can act
  // on whose note it is and where it lives. `now` is injectable so the silence
  // rule is testable without waiting on a clock; nothing else here reads one.
  constructor(
    private readonly spawn: (sessionId: string, host: string) => InlineShellIO,
    private readonly nonce: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Start `runner` for run `id`, on the note's shell for `by.host` or on a
   * fresh overflow shell. `by.client` is required rather than defaulted: a
   * caller that forgot would file every run under one bucket, and `claim`
   * would then find none of them for the client that asked. `by` is an options
   * object because a client id and an ssh destination are both bare strings,
   * and nothing at a call site would catch them the wrong way round.
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
    // One write, so a tty that discards what it has not read yet cannot take
    // the hook and drop the block. Prepending the hook rather than sending it
    // separately is the same guard: what must not happen is the block line
    // arriving without the hook line before it.
    //
    // Re-sending it is safe as often as it happens. A second registration
    // reports nothing extra, because the first clears `__ledge_id` and every
    // later one reads that guard and returns. It stops for good once an ack
    // arrives, one round trip after the shell is up.
    const line = (slot.hooked ? "" : markerInit(this.nonce)) + markerCommand(runner, this.nonce, id);
    slot.echo += line;
    slot.shell.write(line);
  }

  /**
   * SIGINT whatever run `id`'s shell is running, as ^C would.
   *
   * A run that never began is stopped differently. Its command line went into
   * a shell that was not listening for one (ssh reading it as the answer to a
   * host-key question), so there is no job to signal and no marker will ever
   * close the run. The block would then sit on "Running" with a dead button.
   * Stopping it here ends the run and discards the shell, whose state nobody
   * can now describe. The next run spawns a fresh one, on a host ssh has by
   * then been told to trust.
   */
  cancel(sessionId: string, id: string): void {
    const slot = this.slotFor(sessionId, id);
    if (slot) this.interrupt(slot);
  }

  /**
   * Line the pool up with the runs a client can still show: interrupt every
   * run `keep` does not name, and answer which of `keep` is still running.
   * That interrupt is the one `cancel` sends, for the same reason: a run is
   * otherwise stopped only by the panel that shows it, and a client that
   * reloaded has no panels and no run ids (remote.md §7). Scoped to `client`,
   * so no client collects another's runs. A run whose client never comes back
   * is left to the daemon's idle exit, which already waits on `running`
   * (daemon.ts).
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
   * Drain every shell, emitting per-run events. Lifecycle turns here too: an
   * overflow shell is closed when its run ends, and a dead shell (its block
   * ran `exit`, or it was killed) has its open run closed out by the pool.
   * Nothing else can close it now, and a panel left on "Running" would disable
   * that block's run button for good.
   */
  drain(emit: InlineEmit): boolean {
    let spoke = false;
    for (const [sessionId, session] of [...this.sessions]) {
      for (const slot of this.slots(session)) {
        const data = slot.shell.drain();
        if (data) {
          spoke = true;
          // Anything arriving before the run's start marker is kept, or shown,
          // by the rules in SILENT_MS. The parser drops it, and for a run that
          // never begins it is all the panel ever has to show.
          if (slot.activeRun !== null && !slot.began) this.holdOrShow(slot, data, emit);
          for (const ev of slot.parser.feed(data)) {
            // The ready ack is about the shell, not about a run. Nothing
            // downstream has a panel to put it in, and a client told about it
            // could do nothing with it, so it stops here.
            if (ev.type === "ready") {
              slot.hooked = true;
              continue;
            }
            if (ev.type === "began" && ev.blockId === slot.activeRun) {
              // The block is running: its own output starts here, and the
              // preamble held so far was the echo of what the pool typed.
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
        // over what follows, so a question waiting for an answer reaches the
        // panel.
        if (slot.activeRun !== null && !slot.began && !slot.spoke && this.now() - slot.startedAt >= SILENT_MS) {
          slot.spoke = true;
          this.flushPreamble(slot, emit);
        }
        // Stopped, and no marker is coming: the run never started (see cancel)
        // or it started on a shell whose hook never landed (see interrupt).
        // The shell cannot close this run and nothing else will, so the pool
        // does, and the shell is dropped rather than serving the next block
        // from a state nobody can describe.
        if (slot.abandoned && slot.activeRun !== null) {
          this.flushPreamble(slot, emit);
          emit({ type: "ended", blockId: slot.activeRun, exitCode: null }, slot.client);
          this.dropSlot(session, slot);
          continue;
        }
        if (slot.shell.exited) {
          // activeRun as the fallback: the shell can die after the command was
          // written but before its C marker echoed back.
          const open = slot.parser.openBlockId ?? slot.activeRun;
          // A shell that died before its block began printed the reason first
          // ("Host key verification failed", "Permission denied"), so show it
          // even if the silence rule has not fired yet.
          if (open && !slot.began) this.flushPreamble(slot, emit);
          if (open) emit({ type: "ended", blockId: open, exitCode: null }, slot.client);
          this.dropSlot(session, slot);
        }
      }
      if (session.primaries.size === 0 && session.overflow.size === 0) this.sessions.delete(sessionId);
    }
    return spoke;
  }

  /**
   * Whether any inline shell still has input the tty has not taken.
   *
   * Read by the drain loop alone, to decide whether it may slow down: the rest
   * of a paste goes out on the next tick, and with the echo off (`sudo`
   * reading a password) nothing else would tell the loop to stay fast.
   * `running()` answers the question that matters to the daemon. This one only
   * sets a cadence, and a shell that does not report `pending` never holds the
   * loop at full speed.
   */
  pending(): boolean {
    for (const session of this.sessions.values()) {
      for (const slot of this.slots(session)) {
        if (slot.shell.pending === true) return true;
      }
    }
    return false;
  }

  /**
   * Kill all of a note's inline shells so its next run spawns fresh ones, with
   * the note's current params. Unlike closeSession, the tab is still open and
   * watching, so every open run is closed out through `emit`. An open run left
   * alone would leave its panel on "Running" and its run button dead. The
   * drain loop closes runs out the same way when a shell dies on its own.
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

  /** Whether any block is mid-run. The daemon asks this before letting a
   * client that went away take the server with it: a block still running is
   * one reason a server outlives its connection (remote.md §7). An idle shell
   * is not counted here. It is worth keeping only for a client that declared a
   * hold, which `sessionsOpen` below answers instead. */
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
   * This is what a session hold protects: a note's shell keeps the cwd it was
   * `cd`'d to and whatever the last block exported, and nothing else can
   * rebuild that state. A server with no such shell has nothing to hold,
   * however long its client asked for (daemon.ts).
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
  // reporting, held (up to a cap) while they might still be ordinary noise.
  // The cap bounds a shell that chatters forever without ever starting the
  // block. The end of that stream is the informative part, so the oldest chunk
  // is dropped first.
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
    // Nothing is written here. The end-marker hook goes out in the same write
    // as the first block instead (see run): a hook and a block sent separately
    // can arrive separately, and a shell that got the block without the hook
    // begins it and can never end it. Nothing needs the hook sooner. This is
    // only ever reached because a run asked for a shell, and that run is the
    // next thing written.
    return {
      shell,
      parser: new MarkerParser(this.nonce),
      activeRun: null,
      client: "",
      began: false,
      preamble: [],
      preambleLen: 0,
      echo: "",
      startedAt: 0,
      spoke: false,
      abandoned: false,
      hooked: false,
    };
  }

  private slots(session: Session): Slot[] {
    return [...session.primaries.values(), ...session.overflow.values()];
  }

  // Stop what a slot is running, by whichever of the two routes applies: the
  // signal for a run that began, the abandoned flag for one that never did.
  // `cancel` states why they differ, and `claim` needs the same pair.
  //
  // A run that began on a shell with no hook takes the second route too: the
  // signal alone would not end it. The ack printf goes out ahead of the start
  // marker in the same write (see run), so a start marker from an unacked
  // shell is not a race. It means the init line arrived damaged and no prompt
  // on that shell will ever report a D marker. Signalling alone would abort
  // the block and leave the panel on "Running", with its own Stop button the
  // only control that could have ended the run.
  private interrupt(slot: Slot): void {
    slot.shell.interrupt();
    if (!slot.began || !slot.hooked) slot.abandoned = true;
  }

  private slotFor(sessionId: string, id: string): Slot | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    for (const slot of session.primaries.values()) if (slot.activeRun === id) return slot;
    return session.overflow.get(id);
  }

  // A run reached its D marker: free its shell, or retire it. A persistent
  // shell survives to carry cwd and env to its host's next block. An overflow
  // shell is keyed by this run alone, so nothing can be routed to it again and
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
