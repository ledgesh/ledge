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
// Several clients at once, and every push is addressed. A Mac and a phone
// pointed at one machine is the ordinary shape of this rather than an exotic
// one, and this daemon used to serve whichever dialled last and hang up on the
// other, which cost a session to gain a session. What actually needed deciding
// was far smaller: `attached` and the scrollback ring are per SESSION and not
// per client (bun/server.ts), so the one thing two clients cannot share is a
// drawer's keyboard. Notes, search, tags, the registry and the vault never
// needed a rule at all.
//
// So the connections live in a map keyed by client id, and every push names who
// it is for (`Audience` in bun/server.ts). What is left of displacement is the
// job it was always doing underneath: a connection is replaced by a later one
// FROM THE SAME CLIENT, which is how a reconnect takes over from a half-open
// wire nobody has noticed is dead. The reason still travels in the `bye`, and a
// client told it stops instead of re-dialling (shared/transport.ts) — the same
// rule as before, over the one case that cannot cost anybody else their
// session.
//
// What the socket buys, precisely: a run keeps going when the wire drops, and
// the op log (bun/opLog.ts) survives to make the client's replay of what was
// in flight safe. What a client can additionally ASK for is that its idle
// shells keep going too, which is the one case the rules above get wrong on
// their own — a phone suspended by iOS looks exactly like a client that is
// never coming back (HOLD_MAX_MS).
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
 * the entire point of the socket. A client that declared a session hold
 * overrides the LENGTH instead (`HOLD_MAX_MS`), because what it is coming back
 * to is a shell that is merely idle — which `running()` is right not to count
 * and wrong to be asked about.
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

/**
 * The longest a client can ask this daemon to keep its sessions after going
 * away (wire.ts `Hello.hold`).
 *
 * The ask exists because a phone is suspended shortly after it leaves the
 * foreground and is given no moment to say anything on the way out (ios.md §5),
 * so it says it at connect time instead. This is the other half: the client
 * names what it wants and the server names what it will do, and the term is the
 * server's because the process being kept alive is the server's.
 *
 * Ten minutes is a ceiling, not the ordinary grant. It bites only a client
 * asking for something no person waits through; the phone asks for five
 * (mainview/ios.tsx) and gets it whole. Past ten minutes the shell still has
 * its cwd and its exported variables and nobody has the thread of what they
 * were for, and the cost of guessing high is a process on someone's Mac for a
 * phone that is in a pocket.
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

  // Every client being served, keyed by the id from its hello. Keyed rather
  // than a plain set because identity is what both routing questions turn on:
  // which connection a push is addressed to, and which one a fresh connection
  // replaces.
  //
  // Nobody connected is the ORDINARY case here, not an edge: the watcher fires
  // whenever a file moves, a run keeps producing output, and both of those go
  // on happily while every client is away. A push with nowhere to go is
  // dropped, and the state it described is re-read at the next connection's
  // boot. One exception, and it is the one push that describes no state: a
  // run's output is a sequence with nothing to re-read it from, so bun/server.ts
  // holds that before it ever reaches this map.
  const clients = new Map<string, ServerConnection>();

  // The routing itself is bun/audience.ts, shared with the app's own shell:
  // a window is a client too, and one local server under N windows has exactly
  // this to do (remote.md §8a).
  const push = audienceOf(clients, (conn) => conn.push);

  /**
   * Tell every client who else is here (rpc-schema `presence`).
   *
   * The daemon's rather than the server's, because presence is a fact about
   * CONNECTIONS and this is the only thing that has more than one of them: a
   * server in the app's own process has exactly one client and nothing to say.
   *
   * A different list per client, since each is told about the others and never
   * about itself. Cheap enough to build that way: this runs when somebody
   * arrives or leaves, which is a human-scale event, over a map with two or
   * three entries in it.
   */
  function announcePresence(): void {
    const everyone = [...clients].map(([client, conn]) => ({ client, label: conn.label() }));
    for (const [client, conn] of clients) {
      conn.push.presence({ others: everyone.filter((p) => p.client !== client) });
    }
  }

  // Created once and handed to every connection: the window that makes a
  // replayed write apply once has to span the reconnect it exists for.
  const ops = createOpLog();
  // And named once, so a client can tell "the wire came back" from "the server
  // came back". Replaying into a restarted daemon would meet an empty op log
  // and apply the write a second time (wire.ts Hello.instance).
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
    // On the hello and not on the socket. A connection that has not said who
    // it is is not a client yet, and the difference is not hypothetical:
    // clearStaleSocket below decides whether a daemon is behind a socket file
    // by connecting to it and hanging up, and on the accept that probe would
    // be counted as somebody using this server.
    const greet = (): void => {
      const id = conn.client();
      const previous = clients.get(id);
      clients.set(id, conn);
      // Bound to the id the handshake carried, which is why this cannot happen
      // at accept time: until the hello lands there is nobody to answer as, and
      // four of these handlers would answer for the wrong client
      // (bun/server.ts forClient).
      conn.serve(server.forClient(id));
      // AFTER the new one is registered, so the pushes a teardown emits go to
      // the connection that is still here rather than to the one being hung up
      // on.
      //
      // The SAME client only. Two devices are two clients and both stay; one
      // device dialling twice is a reconnect, and what it is reconnecting past
      // is a wire nobody has noticed is dead — taking that over is the point.
      // The reason travels: a client that knows it was replaced stops rather
      // than re-dialling, and two that re-dialled would replace each other for
      // as long as both were running (shared/transport.ts).
      previous?.close("this client opened another connection to this server");
      // After the replacement, so a reconnect is one announcement of the set as
      // it now stands rather than two with a dead connection in the middle. The
      // arriving client is told here too — the same push carries the list it
      // would otherwise have to ask for, which is the round trip remote.md §12
      // is counting.
      announcePresence();
    };
    const conn = serverConnection(io, { build, ops, instance, greeted: greet, holdMax });
    void conn.closed.then(() => {
      // Only while it is still the registered one: a connection replaced by its
      // own client's next one must not delete the replacement on its way out.
      // The announcement is inside the same check for a smaller reason — a
      // replaced connection's departure changes nothing, since its client is
      // still here under the new one, and announcing anyway would push an
      // identical list to every client on every reconnect.
      if (clients.get(conn.client()) === conn) {
        clients.delete(conn.client());
        announcePresence();
      }
      // Recorded on the way out, whether or not anyone else is left: a hold
      // runs from the moment THAT connection ended, and with several clients
      // the last one to leave is not necessarily the one that asked. A phone
      // backgrounding while a Mac stays connected is the ordinary case of
      // exactly that, and its five minutes must not become the Mac's sixty
      // seconds because the Mac happened to quit second.
      const hold = conn.hold();
      if (hold > 0) heldUntil = Math.max(heldUntil, Date.now() + hold);
      // A silent socket closing leaves an unattended daemon exactly as the last
      // client leaving does, and the timer was cleared when it arrived.
      if (clients.size === 0) armIdleExit();
    });
  }

  function armIdleExit(): void {
    if (stopped || idleTimer || idleMs <= 0) return;
    // A hold applies only where there is something to hold: a client that asked
    // for one and opened no shell has nothing to come back TO, and keeping the
    // process for it is the "started by an ssh nobody remembers making" this
    // timer exists to end.
    const held = server.sessionsOpen() ? heldUntil - Date.now() : 0;
    // The longer of the two, never the shorter: a hold is a deadline a client
    // asked to be given, and one that lands inside the ordinary window is
    // already satisfied by it.
    const wait = Math.max(idleMs, held);
    // Seconds once there are enough of them to round without lying. Every hold
    // in production is minutes; the ones that are not are a test's.
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
    for (const conn of clients.values()) conn.close("this server is shutting down");
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
