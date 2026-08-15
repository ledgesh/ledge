// `ledge-server`: this machine's notes, reachable over ssh (remote.md §3).
//
// Two verbs, and the split is the phase 4 change. `serve` is what a client
// runs — `ssh <target> ledge-server serve`, and what an `authorized_keys`
// forced command names (§4) — and it is a byte pump between stdio and the
// daemon's socket. `daemon` is the server itself: it holds the notes, the
// shells, and the watchers, and it outlives every connection to it (§7), which
// is what makes a run survive the wire dropping and what lets a reconnecting
// client replay safely.
//
// A pump rather than a server is also why `serve` needs no protocol knowledge
// at all. It never parses a frame, so an ssh session cannot desynchronize one:
// it moves bytes and reports when they stop.
//
// stdout belongs to the protocol. Every console line is rerouted to stderr
// before anything can log (bun/mcp.ts has the same rule for the same reason):
// one stray byte in a length-prefixed stream desynchronizes it with no way
// back, and the session log keeps a copy either way.
import {
  connectToDaemon,
  DAEMON_LOG,
  IDLE_EXIT_MS,
  IDLE_EXIT_NEVER,
  startDaemon,
  SOCKET_PATH,
} from "./daemon";
import { stdioDuplex } from "./transport";
import { startLogging } from "./log";
import { APP_HOME } from "./workspaces";
import { BUILD_VERSION } from "../shared/version";

/**
 * Pump stdio to the daemon and back. Resolves when either end hangs up.
 *
 * Both directions are closed together: half a pipe is a client waiting on a
 * server that is gone, and the client's own reconnect (bun/transport.ts) is
 * what turns a clean hangup into a new attempt.
 */
export async function serve(): Promise<void> {
  const upstream = await connectToDaemon();
  const mine = stdioDuplex();

  let over!: () => void;
  const done = new Promise<void>((resolve) => (over = resolve));
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    try {
      upstream.close();
    } catch {
      // Already gone.
    }
    over();
  };

  upstream.onData = (chunk) => mine.write(chunk);
  upstream.onClose = end;
  mine.onData = (chunk) => upstream.write(chunk);
  mine.onClose = end;

  console.error(`[serve] ledge-server ${BUILD_VERSION} attached to ${SOCKET_PATH}`);
  await done;
}

/**
 * BE this machine's server.
 *
 * `autostart` is the difference between a daemon `serve` conjured and one
 * somebody asked for, and all it decides is whether the idle timeout applies
 * (daemon.ts, IDLE_EXIT_MS). A container whose PID 1 is this, or a systemd
 * unit, would otherwise be restarted every minute by its own supervisor for
 * doing exactly what it was told.
 */
export async function daemon(autostart = false): Promise<void> {
  const idleMs = autostart ? IDLE_EXIT_MS : IDLE_EXIT_NEVER;
  const d = await startDaemon({ idleMs });
  const life = idleMs > 0 ? `idle exit in ${idleMs}ms` : "staying until stopped";
  console.error(`[daemon] ledge-server ${BUILD_VERSION} on ${SOCKET_PATH}; app home: ${APP_HOME}; ${life}`);
  // A signal is how a supervisor stops this — and how the probe does.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => d.stop());
  await d.done;
}

/**
 * The command line, as something other than a side effect of importing this.
 *
 * A published package's `bin/ledge-server.js` (npmPackage.ts) is its own
 * module and imports this one, which makes `import.meta.main` FALSE in here —
 * so the guard that keeps `bun src/bun/serve.ts` honest is exactly what would
 * make an installed `ledge-server` exit 0 having done nothing. `argv` is
 * shaped like `process.argv` from either entry, since a launcher is the script
 * in its own argv the same way this file is in its.
 */
export async function main(argv: readonly string[]): Promise<never> {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const verb = argv[2] ?? "serve";
  if (verb !== "serve" && verb !== "daemon") {
    console.error("usage: ledge-server [serve|daemon [--autostart]]");
    console.error("  serve   the protocol on stdin and stdout, attached to this machine's daemon");
    console.error("  daemon  BE this machine's server; runs until stopped");
    console.error("            --autostart  exit when idle; what serve passes to the one it starts");
    process.exit(2);
  }

  // Separate files. Both can be running at once on one machine, and two
  // processes appending to one log interleave their lines and race each
  // other's rotation.
  startLogging(verb === "daemon" ? DAEMON_LOG : "ledge-serve");

  if (verb === "daemon") await daemon(argv.includes("--autostart"));
  else await serve();
  process.exit(0);
}

if (import.meta.main) await main(process.argv);
