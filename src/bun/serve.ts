// `ledge-server`: this machine's notes, reachable over ssh (remote.md §3).
//
// Four verbs. `serve` is what a client runs (`ssh <target> ledge-server
// serve`), and what an `authorized_keys` forced command names (§4). It pumps
// bytes between stdio and the daemon's socket and parses no frames, so an ssh
// session cannot desynchronize the protocol. `daemon` holds the notes, the
// shells and the watchers. It outlives every connection to it (§7). A run
// survives the wire dropping, and a reconnecting client can replay safely.
// Phase 4 split the two (§14). `backup-paths` prints the paths a backup has
// to cover and exits (backup.ts, §11). `pair` prints a pairing code (§4b).
//
// stdout belongs to the protocol: one stray byte in a length-prefixed stream
// desynchronizes it with no way back. `main` points `console.log`,
// `console.info` and `console.debug` at stderr before anything logs. The
// session log keeps a copy of the first two (log.ts `startLogging`).
// bun/mcp.ts holds stdout for its own protocol the same way.
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
import { APP_HOME, availableRoots, loadWorkspaces, roots } from "./workspaces";
import { PROFILES_DIR } from "./spawnParams";
import { backupSet } from "./backup";
import {
  containerRefusal,
  HOST_KEY_DIR,
  KEYGEN_PATH,
  pairAddress,
  pairCode,
  pairReport,
  parsePairArgs,
  phoneHostKeys,
} from "./pair";
import { BUILD_VERSION } from "../shared/version";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Pump stdio to the daemon and back. Resolves when either end hangs up.
 *
 * Either end closing ends the pump: `end` closes the daemon socket and
 * resolves, and `main` exits the process, which shuts stdio. Half a pipe
 * would leave a client waiting on a server that is gone. After a clean hangup
 * the client dials again (`reconnectingClient` in shared/transport.ts).
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
 * Be this machine's server.
 *
 * `autostart` marks a daemon that a `serve` started rather than a person. It
 * decides only whether the idle timeout applies (daemon.ts `IDLE_EXIT_MS`).
 * A daemon run as a container's PID 1 or a systemd unit stays until it is
 * stopped, so its supervisor does not restart it every minute.
 */
export async function daemon(autostart = false): Promise<void> {
  const idleMs = autostart ? IDLE_EXIT_MS : IDLE_EXIT_NEVER;
  const d = await startDaemon({ idleMs });
  const life = idleMs > 0 ? `idle exit in ${idleMs}ms` : "staying until stopped";
  console.error(`[daemon] ledge-server ${BUILD_VERSION} on ${SOCKET_PATH}; app home: ${APP_HOME}; ${life}`);
  // A supervisor stops this with a signal, and so does the live probe.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => d.stop());
  await d.done;
}

/**
 * Print the paths a backup of this machine has to cover (backup.ts).
 *
 * A verb rather than a documented path list, because only the server can
 * answer it: external workspace roots are wherever the user attached them,
 * and the registry is the only thing that knows. It prints paths and uploads
 * nothing. restic and rclone already exist, and what they cannot compute is
 * which paths (remote.md §11).
 *
 * The answer goes to `process.stdout` directly, not through a console method.
 * `main` has sent the console to stderr and must keep doing so (one stray
 * byte desynchronizes `serve`'s stream).
 *
 * The include and exclude lists come out of separate invocations. That is the
 * shape the consumer wants:
 *
 *     restic backup --files-from <(ledge-server backup-paths) \
 *                   --exclude-file <(ledge-server backup-paths --exclude)
 */
export async function backupPaths(argv: readonly string[]): Promise<void> {
  await loadWorkspaces();

  // Registered but not on disk: an unmounted volume, or a folder someone moved
  // from underneath the registry. Naming the path fails the whole restic run.
  // Dropping it silently takes a workspace out of the backup set, and nobody
  // finds out until a restore. `backup-paths` warns on stderr instead, so a
  // pipe still gets clean paths.
  const missing = roots().filter((r) => !availableRoots().includes(r));
  for (const r of missing) console.error(`[backup-paths] skipping ${r}: not on disk (unmounted volume?)`);

  const secrets = !argv.includes("--no-secrets");
  const set = backupSet({ appHome: APP_HOME, profilesDir: PROFILES_DIR, roots: availableRoots(), secrets });

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...set, skipped: missing }, null, 2)}\n`);
    return;
  }
  const lines = argv.includes("--exclude") ? set.exclude : set.include;
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Print this machine's pairing code as a QR code, with the link beneath it
 * (pair.ts, remote.md §4b). Returns the exit status. Like `backup-paths`, it
 * writes to `process.stdout` directly and starts no daemon.
 */
export async function pair(argv: readonly string[]): Promise<number> {
  const fail = (message: string, status = 1) => {
    console.error(message);
    return status;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${PAIR_USAGE}\n`);
    return 0;
  }
  const args = parsePairArgs(argv.slice(3));
  if ("error" in args) return fail(`${args.error}\n${PAIR_USAGE}`, 2);
  if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) {
    const refusal = containerRefusal(args);
    if (refusal) return fail(refusal);
  }
  const address = pairAddress(args, process.env.SSH_CONNECTION, hostname());
  if ("error" in address) return fail(address.error, 2);

  let keyText = "";
  if (args.keys === "-") keyText = await Bun.stdin.text();
  else if (args.keys !== undefined) {
    try {
      keyText = readFileSync(args.keys, "utf8");
    } catch {
      return fail(`Could not read ${args.keys}.`);
    }
  } else {
    const files = existsSync(HOST_KEY_DIR) ? readdirSync(HOST_KEY_DIR).filter((f) => /^ssh_host_\w+_key\.pub$/.test(f)) : [];
    for (const file of files) {
      try {
        keyText += `${readFileSync(join(HOST_KEY_DIR, file), "utf8")}\n`;
      } catch {
        // Unreadable here, and ssh-keygen would say nothing more useful.
      }
    }
    if (keyText.trim() === "") {
      return fail(`There are no sshd host keys in ${HOST_KEY_DIR}. If sshd keeps them elsewhere, pass the .pub file with --keys.`);
    }
  }

  let described: string;
  try {
    const p = Bun.spawn([KEYGEN_PATH, "-lf", "-"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    p.stdin.write(keyText);
    await p.stdin.end();
    described = await new Response(p.stdout).text();
    await p.exited;
  } catch (err) {
    return fail(`Could not run ssh-keygen (${err instanceof Error ? err.message : String(err)}).`);
  }
  const keys = phoneHostKeys(described);
  if (keys.length === 0) {
    if (!described.includes("SHA256:")) return fail(`${args.keys === "-" ? "stdin" : (args.keys ?? HOST_KEY_DIR)} holds no public host keys.`);
    return fail(
      "None of these host keys is Ed25519 or ECDSA, and those are the kinds Ledge on a phone can check.\n" +
        "`sudo ssh-keygen -A` creates the missing default keys. Restart sshd after it.",
    );
  }

  const code = pairCode(args.user ?? userInfo().username, address, keys);
  if ("error" in code) return fail(code.error);
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  process.stdout.write(pairReport({ code, keys, hostFrom: address.hostFrom, columns }));
  return 0;
}

const PAIR_USAGE = [
  "usage: ledge-server pair [--user NAME] [--host ADDRESS] [--port N] [--keys FILE]",
  "  --user   the account a phone signs in as (default: whoever runs pair)",
  "  --host   the name or IPv4 address a phone dials (default: this ssh session's address, or the machine's name)",
  "  --port   sshd's port (default: this ssh session's port, or 22)",
  "  --keys   public host keys to describe, - for stdin (default: /etc/ssh/ssh_host_*_key.pub)",
].join("\n");

/**
 * Run the command line. Exported so `bin/ledge-server.js` can call it.
 *
 * That launcher (npmPackage.ts) is its own module and imports this one, so
 * `import.meta.main` is false in here. The guard on the last line covers only
 * `bun src/bun/serve.ts`; a package leaning on it would install a
 * `ledge-server` that exits 0 having done nothing. `argv` is shaped like
 * `process.argv` from either entry: the launcher passes its own
 * `process.argv`, where index 1 is the launcher and the verb is still index 2.
 */
export async function main(argv: readonly string[]): Promise<never> {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const verb = argv[2] ?? "serve";
  if (verb !== "serve" && verb !== "daemon" && verb !== "backup-paths" && verb !== "pair") {
    console.error("usage: ledge-server [serve|daemon [--autostart]|backup-paths [options]|pair [options]]");
    console.error("  serve         the protocol on stdin and stdout, attached to this machine's daemon");
    console.error("  daemon        BE this machine's server; runs until stopped");
    console.error("                  --autostart   exit when idle; what serve passes to the one it starts");
    console.error("  backup-paths  the paths a backup of this machine must cover, one per line");
    console.error("                  --exclude     print the exclusions instead of the inclusions");
    console.error("                  --no-secrets  leave out the profiles dir");
    console.error("                  --json        both lists, plus any root that is not on disk");
    console.error("  pair          a QR code a phone scans to add this server");
    console.error("                  --user, --host, --port, --keys   see `ledge-server pair --help`");
    process.exit(2);
  }

  // `backup-paths` and `pair` read and print. They start no daemon and touch
  // none, so they need no log file of their own and must not rotate the ones
  // a running server is writing.
  if (verb === "backup-paths") {
    await backupPaths(argv);
    process.exit(0);
  }
  if (verb === "pair") process.exit(await pair(argv));

  // `serve` and `daemon` log to separate files. Both can be running at once on
  // one machine, and two processes appending to one log interleave their lines
  // and race each other's rotation.
  startLogging(verb === "daemon" ? DAEMON_LOG : "ledge-serve");

  if (verb === "daemon") await daemon(argv.includes("--autostart"));
  else await serve();
  process.exit(0);
}

if (import.meta.main) await main(process.argv);
