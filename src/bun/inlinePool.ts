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

interface Slot {
  shell: InlineShellIO;
  parser: MarkerParser;
  // The run this shell is executing, marked at write time. parser.openBlockId
  // lags it (the C marker has to echo back through the pty), and that gap is
  // exactly when a second run must NOT pick this shell.
  activeRun: string | null;
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
  constructor(
    private readonly spawn: (sessionId: string, host: string) => InlineShellIO,
    private readonly nonce: string,
  ) {}

  /** Start `runner` for run `id`, on the note's shell for `host` or a fresh overflow one. */
  run(sessionId: string, id: string, runner: string, host: string = LOCAL_HOST): void {
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
    const size = this.pendingResize.get(id);
    if (size) {
      this.pendingResize.delete(id);
      slot.shell.resize(size.cols, size.rows);
    }
    slot.shell.write(markerCommand(runner, this.nonce, id));
  }

  /** SIGINT whatever run `id`'s shell is running, as ^C would. */
  cancel(sessionId: string, id: string): void {
    this.slotFor(sessionId, id)?.shell.interrupt();
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
  drain(emit: (ev: InlineEvent) => void): void {
    for (const [sessionId, session] of [...this.sessions]) {
      for (const slot of this.slots(session)) {
        const data = slot.shell.drain();
        if (data) {
          for (const ev of slot.parser.feed(data)) {
            emit(ev);
            if (ev.type === "ended") this.runEnded(session, slot, ev.blockId);
          }
        }
        if (slot.shell.exited) {
          // activeRun as the fallback: the shell can die after the command was
          // written but before its C marker echoed back.
          const open = slot.parser.openBlockId ?? slot.activeRun;
          if (open) emit({ type: "ended", blockId: open, exitCode: null });
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
  restartSession(sessionId: string, emit: (ev: InlineEvent) => void): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const slot of this.slots(session)) {
        const open = slot.parser.openBlockId ?? slot.activeRun;
        if (open) emit({ type: "ended", blockId: open, exitCode: null });
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

  /** Process exit: close every shell of every note. */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      for (const slot of this.slots(session)) slot.shell.close();
    }
    this.sessions.clear();
    this.pendingResize.clear();
  }

  private newSlot(sessionId: string, host: string): Slot {
    const shell = this.spawn(sessionId, host);
    // Install the end-marker hook before any block can run. Its own echo lands
    // outside every C..D pair, so the parser drops it and no block ever sees it.
    shell.write(markerInit(this.nonce));
    return { shell, parser: new MarkerParser(this.nonce), activeRun: null };
  }

  private slots(session: Session): Slot[] {
    return [...session.primaries.values(), ...session.overflow.values()];
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
