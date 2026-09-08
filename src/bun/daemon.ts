// The server as a process that outlives its clients (remote.md §1, §7).
//
// Up to phase 3 (remote.md §14) a server was its connection: `ssh host
// ledge-server serve` ran a fresh one per ssh, so a dropped link killed the
// shells with it. That made §7's "sessions outlive connections" false for the
// case it was written for, a build running on a machine you are not sitting at.
// The server now sits behind a unix socket in the app home, `serve` pumps bytes
// between stdio and that socket, and a connection is something the server has
// rather than something it is.
//
// The daemon serves several clients at once. Each has one entry in the map
// below, and every push names the client it is for (`Audience` in
// bun/server.ts). It used to serve whichever client dialled last and hang up on
// the other, so one device connecting cost another device its session. What
// needed a rule was smaller: a session's `owner` and its scrollback ring are
// per session and not per client (bun/server.ts), so two clients cannot share
// a drawer's keyboard. Notes, search, tags, the registry and the vault need
// none.
//
// Displacement replaces a connection only with a later one from the same
// client, which is how a reconnect takes over from a half-open wire. The reason
// travels in the `bye`, and a client told it stops instead of re-dialling
// (shared/transport.ts).
//
// The socket keeps a run going when the wire drops, and keeps the op log
// (bun/opLog.ts) so the client's replay of what was in flight is safe. A client
// can also ask for its idle shells to be kept (HOLD_MAX_MS). That ask is the
// one case the rules above get wrong on their own: a phone suspended by iOS
// looks the same as a client that is never coming back.
import { chmodSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type NativeDeps } from "./server";
import { fedDuplex, type Duplex } from "../shared/transport";
import { serverConnection, socketWriter, type ServerConnection } from "./transport";
import { audienceOf } from "./audience";
import { createOpLog } from "./opLog";
import { LOG_DIR } from "./log";
import { APP_HOME } from "./workspaces";
import { BUILD_VERSION } from "../shared/version";

/** The unix socket the daemon listens on. It lives in the app home, so
 * LEDGE_NOTES_ROOT moves it too and a scratch probe gets its own daemon rather
 * than talking to the real one. Dotted like every other app-owned entry
 * there. */
export const SOCKET_PATH = join(APP_HOME, ".server.sock");

/** The daemon's pid, beside the socket, so a process nobody started by hand can
 * still be stopped by hand: `kill $(cat ~/.ledge/.server.pid)`. The live probe
 * reads it too (scripts/probe-ssh.ts). Removed on a clean exit. A stale file is
 * harmless: nothing reaches the daemon through it. */
export const PID_PATH = join(APP_HOME, ".server.pid");

/** The daemon's log basename, shared by the process's own console tee and by
 * the raw stderr its parent hands it. */
export const DAEMON_LOG = "ledge-server";

// A server has no window: no folder dialog, no pasteboard, no menu bar
// (remote.md §5). The seams are absent rather than stubbed, so the handlers
// that need one refuse with a reason instead of silently doing nothing.
const HEADLESS: NativeDeps = {};

/**
 * How long an idle daemon waits before exiting (remote.md §1, §7).
 *
 * The wait is there so a client that quits and comes back (a connection
 * switch, an app restart, a reconnect) finds the same server rather than
 * paying for a fresh boot. `running()` keeps a daemon that has a build in
 * flight. A session hold lengthens the wait instead (`HOLD_MAX_MS`), covering
 * shells that are merely idle, which `running()` does not count. Only an
 * autostarted daemon exits at all: `serve.ts` passes `idleMs: 0` for one a
 * person or a unit file started (remote.md §11).
 */
export const IDLE_EXIT_MS = 60_000;
/** `idleMs` for a daemon that should stay until something stops it. */
export const IDLE_EXIT_NEVER = 0;

/**
 * The longest a client can ask this daemon to keep its sessions after going
 * away (wire.ts `Hello.hold`, remote.md §7).
 *
 * A client asks at connect time because iOS suspends a phone shortly after it
 * leaves the foreground, giving it no moment to say anything on the way out
 * (ios.md §5). The client names what it wants and the server names what it
 * will grant, since the process being kept alive is the server's. Ten minutes
 * constrains no real client: every client asks for five (`SESSION_HOLD_MS` in
 * shared/transport.ts) and gets it whole. Past ten minutes the shell still has
 * its cwd and its exported variables, but nobody remembers what they were for,
 * and a process is running for a phone that is in a pocket.
 */
export const HOLD_MAX_MS = 10 * 60_000;

export interface DaemonOpts {
  socketPath?: string;
  pidPath?: string;
  /** Milliseconds of idleness before exiting; `IDLE_EXIT_NEVER` to stay. */
  idleMs?: number;
  /** The ceiling on a client's session hold; `HOLD_MAX_MS` by default. */
  holdMs?: number;
  build?: string;
}

export interface Daemon {
  /** Resolves when the daemon has stopped: idle timeout, or stop(). */
  done: Promise<void>;
  stop(): void;
}

export async function startDaemon(opts: DaemonOpts = {}): Promise<Daemon> {
  const socketPath = opts.socketPath ?? SOCKET_PATH;
  const pidPath = opts.pidPath ?? PID_PATH;
  const idleMs = opts.idleMs ?? IDLE_EXIT_MS;
  const holdMax = opts.holdMs ?? HOLD_MAX_MS;
  const build = opts.build ?? BUILD_VERSION;

  mkdirSync(APP_HOME, { recursive: true });
  await clearStaleSocket(socketPath);

  // Every client being served, keyed by the id from its hello. A map rather
  // than a plain set because both routing questions turn on identity: which
  // connection a push is addressed to, and which one a fresh connection
  // replaces. An empty map is the ordinary case here, and a push with nowhere
  // to go is dropped (bun/audience.ts). Run output is the exception: it
  // describes no state for the next connection's boot to re-read, so
  // bun/server.ts holds it before it reaches this map.
  const clients = new Map<string, ServerConnection>();

  // The routing itself is bun/audience.ts, shared with the app's own shell:
  // a window is a client too, and one local server under N windows has exactly
  // this to do (remote.md §8a).
  const push = audienceOf(clients, (conn) => conn.push);

  /**
   * Tell every client who else is here (rpc-schema `presence`).
   *
   * It lives in the daemon rather than the server because presence is a fact
   * about connections, and only the code holding the connections knows them.
   * bun/index.ts does the same for the windows on this Mac
   * (`announceLocalPresence`). Each client gets a different list, since it is
   * told about the others and never about itself. Building one list per client
   * is cheap: this runs when somebody arrives or leaves, over a map with two
   * or three entries.
   */
  function announcePresence(): void {
    const everyone = [...clients].map(([client, conn]) => ({ client, label: conn.label() }));
    for (const [client, conn] of clients) {
      conn.push.presence({ others: everyone.filter((p) => p.client !== client) });
    }
  }

  // Created once and handed to every connection. The window that makes a
  // replayed write apply once has to span the reconnect it exists for.
  const ops = createOpLog();
  // A fresh id per daemon, so a client can tell "the wire came back" from "the
  // server came back". Replaying into a restarted daemon would meet an empty op
  // log and apply the write a second time (wire.ts `Hello.instance`).
  const instance = crypto.randomUUID();

  const server = await createServer({ push, native: HEADLESS });

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // The latest moment any departed client asked to still find its sessions
  // here. A deadline rather than a duration, because it is set when a
  // connection ends and read whenever the last one does, which are two
  // different moments once there is more than one client.
  let heldUntil = 0;
  let settleDone!: () => void;
  const done = new Promise<void>((resolve) => (settleDone = resolve));
  let stopped = false;

  const listener = Bun.listen<{ io: ReturnType<typeof fedDuplex>; out: ReturnType<typeof socketWriter> }>({
    unix: socketPath,
    socket: {
      open(socket) {
        // Through socketWriter, not straight at the socket: a response bigger
        // than the kernel's send buffer is written in pieces, and the pieces
        // past the first are this end's to remember (bun/transport.ts).
        const out = socketWriter(socket);
        const io = fedDuplex({
          write: (bytes) => out.write(bytes),
          close: () => void socket.end(),
        });
        socket.data = { io, out };
        accept(io);
      },
      data(socket, chunk) {
        socket.data.io.feed(new Uint8Array(chunk));
      },
      drain(socket) {
        socket.data.out.drain();
      },
      close(socket) {
        socket.data.io.finish();
      },
      error(socket, err) {
        console.error("[daemon] socket error:", err);
        socket.data.io.finish();
      },
    },
  });

  // 0600 rather than whatever the umask gives. The socket is in the app home,
  // which is one user's. Anything that can open this socket can read every note
  // on the machine and run commands as this user. That is the authority a
  // restricted key narrows (remote.md §4a).
  try {
    chmodSync(socketPath, 0o600);
  } catch (err) {
    console.error("[daemon] could not restrict the socket's permissions:", err);
  }

  // After the listen, so the file only exists once there is something to
  // connect to. Not fatal: a daemon nobody can find by pid is still a daemon,
  // and the socket is what anything actually uses.
  try {
    writeFileSync(pidPath, `${process.pid}\n`);
  } catch (err) {
    console.error("[daemon] could not write the pid file:", err);
  }

  function accept(io: Duplex): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    // The daemon registers a client on its hello, not on the accept. A
    // connection that has not said who it is is not a client yet, and the
    // difference is not hypothetical: clearStaleSocket below tests for a live
    // daemon by connecting and hanging up, and registering at accept would
    // count that probe as somebody using this server.
    const greet = (): void => {
      const id = conn.client();
      const previous = clients.get(id);
      clients.set(id, conn);
      // Bound to the id the handshake carried, which is why it cannot happen at
      // accept time: until the hello lands there is nobody to answer as, and
      // four of these handlers would answer for the wrong client
      // (bun/server.ts `forClient`).
      conn.serve(server.forClient(id, conn.device()));
      // The daemon closes the previous connection after registering the new
      // one, so the pushes a teardown emits go to the connection that is still
      // here rather than to the one being hung up on.
      //
      // The daemon displaces the same client only. Two devices are two clients
      // and both stay. One device dialling twice is a reconnect, taking over
      // from a wire nobody has noticed is dead. The reason travels with the
      // close: a client that knows it was replaced stops instead of re-dialling,
      // and two that re-dialled would replace each other for as long as both
      // ran (shared/transport.ts).
      previous?.close("this client opened another connection to this server");
      // After the replacement, so a reconnect makes one announcement of the set
      // as it now stands rather than two with a dead connection in the middle.
      // The arriving client is told here too: the same push carries the list it
      // would otherwise have to ask for, which saves a round trip (remote.md
      // §12).
      announcePresence();
    };
    const conn = serverConnection(io, { build, ops, instance, greeted: greet, holdMax });
    void conn.closed.then(() => {
      // Only while this is still the registered connection. A connection its
      // own client has already replaced must not delete the replacement on its
      // way out. The announcement sits inside the same check because the client
      // is still here under the new connection, so the list has not changed and
      // announcing would repeat it to everybody on every reconnect.
      if (clients.get(conn.client()) === conn) {
        clients.delete(conn.client());
        announcePresence();
      }
      // Recorded on the way out whether or not anyone else is left, because a
      // hold runs from the moment that connection ended and the last client to
      // leave is not necessarily the one that asked. A phone backgrounding
      // while a Mac stays connected is the ordinary case: its five minutes must
      // not become the Mac's sixty seconds because the Mac quit second.
      const hold = conn.hold();
      if (hold > 0) heldUntil = Math.max(heldUntil, Date.now() + hold);
      // A silent socket closing leaves an unattended daemon exactly as the last
      // client leaving does, and the timer was cleared when it arrived.
      if (clients.size === 0) armIdleExit();
    });
  }

  function armIdleExit(): void {
    if (stopped || idleTimer || idleMs <= 0) return;
    // A hold applies only where there is something to hold. A client that asked
    // for one and opened no shell has nothing to come back to, and a process
    // kept for it is the daemon nobody asked for that this timer exists to end
    // (`IDLE_EXIT_MS`, remote.md §7).
    const held = server.sessionsOpen() ? heldUntil - Date.now() : 0;
    // The longer of the two, never the shorter: a hold is a deadline a client
    // asked to be given, and one that lands inside the ordinary window is
    // already satisfied by it.
    const wait = Math.max(idleMs, held);
    // The wait logs as seconds once it is long enough to round without
    // misleading. Every hold in production is minutes; the shorter ones come
    // from tests.
    if (wait !== idleMs) {
      console.error(`[daemon] holding sessions for ${wait >= 10_000 ? `${Math.round(wait / 1000)}s` : `${wait}ms`}`);
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients.size > 0) return;
      // Asked at the deadline rather than when the client left: a run that
      // finishes in the meantime should not hold the process, and one that
      // starts cannot (nobody is here to start it).
      if (server.running()) return armIdleExit();
      console.error(`[daemon] no client and nothing running; exiting (${socketPath})`);
      stop();
    }, wait);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (idleTimer) clearTimeout(idleTimer);
    // The close says `back`, so the client treats this as a stop rather than a
    // refusal (wire.ts `bye`). Most daemon exits are temporary: an idle
    // timeout, a service restart, a SIGTERM sent by hand. Said as final, this
    // would end the client's reconnect ladder and leave nothing dialling until
    // somebody pressed Reconnect (shared/transport.ts). The displacing close in
    // `accept` above is the one that is final.
    for (const conn of clients.values()) conn.close("this server is shutting down", true);
    clients.clear();
    listener.stop(true);
    server.shutdown();
    // Best-effort: a socket file left behind is swept by the next daemon, and
    // failing to remove either must not stop this one from exiting.
    for (const path of [socketPath, pidPath]) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
    settleDone();
  }

  armIdleExit();
  return { done, stop };
}

/**
 * Remove a socket file no daemon is behind.
 *
 * A unix socket outlives the process that made it, so a daemon that was killed
 * leaves a path `listen` then refuses as taken. Connecting is the only way to
 * tell a stale file from a live one: the filesystem entry looks identical
 * either way. A file with something listening behind it is left alone, and
 * `Bun.listen` in `startDaemon` then throws, which is what should happen: two
 * daemons on one app home would be two servers owning one set of notes, one
 * watcher pair per root, and two writers racing every atomic rename.
 */
async function clearStaleSocket(path: string): Promise<void> {
  const live = await tryConnect(path);
  if (live) {
    live.close();
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    // Not there, which is the common case.
  }
}

// --- the client side of the socket -------------------------------------------

/**
 * Connect to this machine's daemon, starting one if there is none.
 *
 * The retry loop covers a race: two `serve` processes can find no socket at the
 * same moment and both spawn a daemon. One of them wins the listen and the
 * other throws and exits. Both then connect to the winner, so the loop only has
 * to wait and try again.
 */
export async function connectToDaemon(
  opts: { socketPath?: string; spawn?: () => void; timeoutMs?: number } = {},
): Promise<Duplex> {
  const socketPath = opts.socketPath ?? SOCKET_PATH;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let spawned = false;

  for (;;) {
    const duplex = await tryConnect(socketPath);
    if (duplex) return duplex;
    if (!spawned) {
      spawned = true;
      (opts.spawn ?? spawnDaemon)();
    }
    if (Date.now() >= deadline) {
      throw new Error(`no ledge-server answered at ${socketPath} within ${Math.round(timeoutMs / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

type Fed = ReturnType<typeof fedDuplex>;

async function tryConnect(socketPath: string): Promise<Fed | null> {
  let io: Fed | null = null;
  let out: ReturnType<typeof socketWriter> | null = null;
  try {
    const socket = await Bun.connect<undefined>({
      unix: socketPath,
      socket: {
        // Bun delivers nothing before `connect` resolves, and fedDuplex holds
        // whatever arrives before a reader is attached, so neither of these
        // can fire into a null io.
        data: (_s, chunk) => io?.feed(new Uint8Array(chunk)),
        // This end writes requests rather than responses, so it overflows the
        // send buffer far less often than the daemon's end does. Far less often
        // is not never: a paste of a large image is one write.
        drain: () => out?.drain(),
        close: () => io?.finish(),
        error: () => io?.finish(),
      },
    });
    out = socketWriter(socket);
    io = fedDuplex({
      write: (bytes) => out!.write(bytes),
      close: () => void socket.end(),
    });
    return io;
  } catch {
    // No socket file, or one with nothing behind it. Both mean "start one".
    return null;
  }
}

/**
 * Start a daemon that outlives this process.
 *
 * Detached, and not sharing this process's stdio: over ssh stdout is the
 * protocol, and one stray byte desynchronizes a length-prefixed stream with no
 * way back (bun/serve.ts). Its stderr goes to the file its own console tee
 * writes, so a crash Bun reports before any app code runs is not lost. Both
 * writers open that file O_APPEND, the one interleaving guarantee POSIX gives.
 *
 * `process.execPath` is the compiled binary in a shipped build and `bun` in a
 * checkout, so the script path goes back on the command line only in the second
 * case: `bun serve.ts daemon` there, `ledge-server daemon` here.
 */
function spawnDaemon(): void {
  // --autostart is what makes the idle timeout apply: this daemon exists
  // because a connection wanted one, so it should go when connections stop
  // coming. One typed by a person, or written into a unit file, should not.
  const head = /(^|\/)bun$/.test(process.execPath) ? [process.execPath, Bun.main] : [process.execPath];
  const argv = [...head, "daemon", "--autostart"];
  let errFd: number | "ignore" = "ignore";
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    errFd = openSync(join(LOG_DIR, `${DAEMON_LOG}.log`), "a");
  } catch {
    // No log to write to. Losing the daemon's crash output is bad; refusing to
    // start it over that would be worse.
  }
  Bun.spawn({ cmd: argv, stdin: "ignore", stdout: "ignore", stderr: errFd }).unref();
}
