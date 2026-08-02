// The server as a process that outlives its clients (remote.md §1, §7).
//
// Up to phase 3 a server WAS its connection: `ssh host ledge-server serve` ran
// a fresh one per ssh, so a dropped link killed the shells with it. That makes
// §7's "sessions outlive connections" false for exactly the case it was
// written for — a build running on a machine you are not sitting at. So the
// server moves behind a unix socket in the app home, `serve` becomes a pump
// between stdio and that socket, and a connection is a thing the server has
// rather than a thing it is.
//
// One client at a time, and a new one displaces the old. That is not a
// limitation smuggled in as a policy: `attached` and the scrollback ring are
// per SESSION, not per client (bun/server.ts), so two clients watching one
// note's drawer would be one stream with two readers and no rule for who gets
// what. Displacing is the honest version of one connection at a time
// (remote.md §8), and it is also what makes a reconnect work — the new
// connection takes over from the half-open one nobody has noticed is dead.
//
// What the socket buys, precisely: a run keeps going when the wire drops, and
// the op log (bun/opLog.ts) survives to make the client's replay of what was
// in flight safe.
import { chmodSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type NativeDeps, type ServerPush } from "./server";
import { fedDuplex, serverConnection, type Duplex, type ServerConnection } from "./transport";
import { createOpLog } from "./opLog";
import { LOG_DIR } from "./log";
import { APP_HOME } from "./workspaces";
import { PUSH_MESSAGES } from "../shared/wire";
import { BUILD_VERSION } from "../shared/version";

/** In the app home, so LEDGE_NOTES_ROOT moves it too and a scratch probe gets
 * its own daemon rather than talking to the real one. Dotted like every other
 * app-owned entry there. */
export const SOCKET_PATH = join(APP_HOME, ".server.sock");

/** Beside it, because a process nobody started by hand is a process nobody
 * can find by hand. `kill $(cat ~/.ledge/.server.pid)` is the answer to "how
 * do I stop the thing my ssh session left running", and it is what the live
 * probe uses. Removed on a clean exit; a stale one is harmless, since the
 * socket is what anything actually connects to. */
export const PID_PATH = join(APP_HOME, ".server.pid");

/** The daemon's log basename, shared by the process's own console tee and by
 * the raw stderr its parent hands it. */
export const DAEMON_LOG = "ledge-server";

// A server has no window: no folder dialog, no pasteboard, no menu bar
// (remote.md §5). The seams are absent rather than stubbed, so the handlers
// that need one refuse with a reason instead of silently doing nothing.
const HEADLESS: NativeDeps = {};

/**
 * How long an idle daemon waits before exiting.
 *
 * It exits at all because the alternative is a process per machine forever,
 * started by an ssh nobody remembers making. It waits because a client that
 * quits and comes back — a connection switch, an app restart, a reconnect —
 * should find the same server rather than pay for a fresh boot.
 *
 * `running()` overrides both: a daemon with a build in flight stays, which is
 * the entire point of the socket.
 *
 * The reason is entirely about the daemon nobody asked for, so it applies only
 * to that one. A daemon somebody STARTED — a systemd unit, the container's PID
 * 1 (`Dockerfile`) — stays until it is stopped, which `serve.ts` asks for with
 * `idleMs: 0`. A supervisor restarting a process that correctly exited, every
 * minute, forever, is not a design anyone would choose on purpose.
 */
export const IDLE_EXIT_MS = 60_000;
/** `idleMs` for a daemon that should stay until something stops it. */
export const IDLE_EXIT_NEVER = 0;

export interface DaemonOpts {
  socketPath?: string;
  pidPath?: string;
  /** Milliseconds of idleness before exiting; `IDLE_EXIT_NEVER` to stay. */
  idleMs?: number;
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
  const build = opts.build ?? BUILD_VERSION;

  mkdirSync(APP_HOME, { recursive: true });
  await clearStaleSocket(socketPath);

  // The one connection being served, if any. Every push goes through this
  // indirection rather than being bound at createServer time, because the
  // server outlives the thing it pushes to — which is the whole change.
  //
  // Nobody attached is the ORDINARY case here, not an edge: the watcher fires
  // whenever a file moves, a run keeps producing output, and both of those go
  // on happily while the client is away. A push with nowhere to go is dropped,
  // and the state it described is re-read at the next connection's boot.
  let live: ServerConnection | null = null;
  const push = Object.fromEntries(
    PUSH_MESSAGES.map((m) => [
      m,
      (p: unknown) => {
        const to = live;
        if (to) (to.push as unknown as Record<string, (p: unknown) => void>)[m]!(p);
      },
    ]),
  ) as unknown as ServerPush;

  // Created once and handed to every connection: the window that makes a
  // replayed write apply once has to span the reconnect it exists for.
  const ops = createOpLog();
  // And named once, so a client can tell "the wire came back" from "the server
  // came back". Replaying into a restarted daemon would meet an empty op log
  // and apply the write a second time (wire.ts Hello.instance).
  const instance = crypto.randomUUID();

  const server = await createServer({ push, native: HEADLESS, client: () => live?.client() ?? "" });

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let settleDone!: () => void;
  const done = new Promise<void>((resolve) => (settleDone = resolve));
  let stopped = false;

  const listener = Bun.listen<{ io: ReturnType<typeof fedDuplex> }>({
    unix: socketPath,
    socket: {
      open(socket) {
        const io = fedDuplex({
          write: (bytes) => void socket.write(bytes),
          close: () => void socket.end(),
        });
        socket.data = { io };
        accept(io);
      },
      data(socket, chunk) {
        socket.data.io.feed(new Uint8Array(chunk));
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

  // The socket is the app home's, and the app home is one user's. 0600 rather
  // than the umask's guess: anything that can open this socket can read every
  // note on the machine and run commands as this user, which is precisely the
  // authority ssh spent §4 restricting.
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
    const previous = live;
    const conn = serverConnection(io, { build, ops, instance });
    live = conn;
    conn.serve(server.requests);
    // AFTER the new one is live, so the pushes a teardown emits go to the
    // client that is still here rather than to the one being hung up on.
    previous?.close("another client connected to this server");
    void conn.closed.then(() => {
      if (live === conn) {
        live = null;
        armIdleExit();
      }
    });
  }

  function armIdleExit(): void {
    if (stopped || idleTimer || idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (live) return;
      // Asked at the deadline rather than when the client left: a run that
      // finishes in the meantime should not hold the process, and one that
      // starts cannot (nobody is here to start it).
      if (server.running()) return armIdleExit();
      console.error(`[daemon] no client and nothing running; exiting (${socketPath})`);
      stop();
    }, idleMs);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (idleTimer) clearTimeout(idleTimer);
    live?.close("this server is shutting down");
    live = null;
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
 * either way.
 *
 * A file with something LISTENING is left alone, and `listen` then throws —
 * which is the outcome to want, because two daemons on one app home would be
 * two servers owning one set of notes, one watcher pair per root, and two
 * writers racing every atomic rename.
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
 * The retry loop is the race: two `serve` processes can find no socket at the
 * same moment and both spawn a daemon. One of them wins the listen, the other
 * throws and exits, and both connect to the winner — so the loop only has to
 * be patient, not clever.
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
  try {
    const socket = await Bun.connect<undefined>({
      unix: socketPath,
      socket: {
        // Bun delivers nothing before `connect` resolves, and fedDuplex holds
        // whatever arrives before a reader is attached, so neither of these
        // can fire into a null io.
        data: (_s, chunk) => io?.feed(new Uint8Array(chunk)),
        close: () => io?.finish(),
        error: () => io?.finish(),
      },
    });
    io = fedDuplex({
      write: (bytes) => void socket.write(bytes),
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
 * Detached, and NOT sharing this process's stdio: over ssh, stdout IS the
 * protocol, and one stray byte desynchronizes a length-prefixed stream with no
 * way back (bun/serve.ts). Its stderr goes to the file its own console tee
 * writes, so a crash Bun reports before any of our code runs is not lost to
 * /dev/null — the two writers are both O_APPEND on the same file, which is the
 * one interleaving guarantee POSIX actually gives.
 *
 * `process.execPath` is the compiled binary in a shipped build and `bun` in a
 * checkout, which is why the script path goes back on the command line only in
 * the second case: `bun serve.ts daemon` there, `ledge-server daemon` here.
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
