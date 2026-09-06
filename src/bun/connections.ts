// Which server this client talks to (remote.md §8).
//
// A connection is client-side configuration: a display name, an ssh
// destination, a key to offer, the host key pinned when it was added, and when
// it was last reached. Nothing about it is stored on a server, so a server has
// no opinion about who connects to it. Moving this app to another Mac carries
// the list without touching any notes.
//
// One connection at a time. Switching tears the session down and rebuilds it,
// so the process holds one server's registry, search, tags and trash at a
// time (§8).
//
// The local server is a connection too, and not a stored one. It is always
// present, cannot be edited, and cannot be removed, so "no connection
// configured" is never a state the app has to render. The local case is not
// special, only cheaper (§1).
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isHostName } from "../shared/frontmatter";
import { hostPart, isPort, LOCAL_ID, parseAuth, PORT_UNSET, type AuthMode } from "../shared/connections";
import { CLIENT_HOME, ensureClientHome } from "./clientHome";
import { ASKPASS_ACCOUNT_ENV } from "./secrets";

// Re-exports from shared/connections.ts: the half of a connection that is a
// fact about ssh rather than about this machine's files. Bun-side callers keep
// one import path for "what a connection is". The phone imports those same
// functions directly, having no Bun to reach them through.
export {
  DEFAULT_PORT,
  hostPart,
  knownHostsHost,
  LOCAL_ID,
  parseAuth,
  parsePort,
  pinFitsHost,
  pinnedHost,
  PORT_UNSET,
  validateConnection,
  validatePassword,
  type AuthMode,
} from "../shared/connections";

export const CONNECTIONS_PATH = join(CLIENT_HOME, "connections.json");

// Ledge's own known_hosts, re-rendered from the connection records every time
// the list is saved (`saveConnections` below). A separate file keeps what
// Ledge pinned legible and revocable on its own, with no edits to the
// known_hosts every other ssh on the machine depends on.
export const KNOWN_HOSTS_PATH = join(CLIENT_HOME, "known_hosts");

// Fixed, not PATH-resolved, for the same reason bun/remoteSpawn.ts fixes it:
// these are spawned without a shell, and every macOS ships them here.
export const SSH_PATH = "/usr/bin/ssh";
export const KEYSCAN_PATH = "/usr/bin/ssh-keyscan";
export const KEYGEN_PATH = "/usr/bin/ssh-keygen";

export interface Connection {
  id: string;
  name: string;
  /** An ssh destination (`host`, `user@host`, a ~/.ssh/config alias), or "" for
   * the server in this process. Never `host:port`. The port is its own field,
   * because that is what ssh takes (`-p`) and what every other client's form
   * asks for separately. */
  destination: string;
  /** Where sshd listens, or PORT_UNSET to let ssh decide. Unset is what keeps
   * a `~/.ssh/config` alias's own `Port` working (shared/connections.ts). */
  port: number;
  /** A private key to offer, or "" to let ssh's own configuration decide.
   * Always "" when `auth` is "password", where no key is offered at all. */
  keyPath: string;
  /** Which door this connection goes through (shared/connections.ts). The
   * password itself is never here: it is in the keychain, and only the askpass
   * helper reads it (bun/secrets.ts). */
  auth: AuthMode;
  /** The known_hosts line pinned when this connection was added, or "" when
   * the host was already trusted by the user's own ssh. Either way ssh refuses
   * a changed key; the difference is only whose file recorded it. */
  hostKey: string;
  /** ms epoch, 0 for never. Written on a successful handshake. */
  lastReached: number;
}

export const LOCAL_CONNECTION: Connection = Object.freeze({
  id: LOCAL_ID,
  name: "This Mac",
  destination: "",
  port: PORT_UNSET,
  keyPath: "",
  auth: "key",
  hostKey: "",
  lastReached: 0,
});

interface Stored {
  version: 1;
  selected: string;
  connections: Connection[];
}

// --- pure core (unit-tested in connections.test.ts) --------------------------

/**
 * The stored file, self-healing. Machine-written state (architecture.md §6):
 * an entry that does not parse costs only itself, and a file that fails
 * entirely leaves only the local server, so the app still opens. The
 * alternative would be an error dialog over a file no human edits. An entry
 * claiming the local id is dropped, since that id names the server in this
 * process and a stored record wearing it could shadow the local connection.
 */
export function parseConnections(raw: unknown): { connections: Connection[]; selected: string } {
  const root = isRecord(raw) ? raw : {};
  const list = Array.isArray(root["connections"]) ? root["connections"] : [];
  const connections: Connection[] = [];
  for (const entry of list) {
    const conn = parseConnection(entry);
    if (conn && conn.id !== LOCAL_ID && !connections.some((c) => c.id === conn.id)) connections.push(conn);
  }
  const selected = typeof root["selected"] === "string" ? root["selected"] : LOCAL_ID;
  // A selection naming nothing falls back to the local server, not to some
  // other stored connection. The app opens onto this machine rather than onto
  // one the user never picked (remote.md §8).
  return { connections, selected: connections.some((c) => c.id === selected) ? selected : LOCAL_ID };
}

function parseConnection(raw: unknown): Connection | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  const name = str(raw["name"]);
  const destination = str(raw["destination"]);
  if (!id || !name || !isHostName(destination)) return null;
  const port = raw["port"];
  return {
    id,
    name,
    destination,
    // A port that is not one costs itself and not the whole record. The
    // connection still opens on whatever ssh decides, which is where every
    // record written before this field existed already opens.
    port: typeof port === "number" && isPort(port) ? port : PORT_UNSET,
    keyPath: str(raw["keyPath"]),
    // Only "password" selects the password door. Any other value, and any
    // record written before this field existed, comes back as "key"
    // (shared/connections.ts parseAuth).
    auth: parseAuth(raw["auth"]),
    hostKey: str(raw["hostKey"]),
    lastReached: typeof raw["lastReached"] === "number" && raw["lastReached"] > 0 ? raw["lastReached"] : 0,
  };
}

/**
 * How long a silent wire stays undetected, and what bounds a dial into one.
 * Why these numbers and not others: remote.md §7.
 *
 * ssh sends a keepalive after `ALIVE_INTERVAL_S` seconds with nothing
 * received, and hangs up once `ALIVE_COUNT` of them go unanswered. That is
 * about twenty seconds. Both options are off by default. A wire that stops
 * carrying bytes without closing (wifi gone, a laptop moved between networks,
 * a middlebox that dropped the flow) sends no FIN and no RST. Without these
 * options ssh has nothing to notice, and the reconnect ladder in
 * shared/transport.ts waits on an event that never arrives. The app goes on
 * saying it is connected and every request sits pending. `TCPKeepAlive` does
 * not help, since macOS first probes an idle socket after two hours.
 * `scripts/probe-ssh.ts` cuts a real wire and measures this.
 *
 * Twenty seconds is more eager than ssh's suggested 45. Hanging up on a link
 * that was only stalled costs a reconnect: in-flight requests replay under
 * their own op ids, the server is the same instance, and the sessions are
 * still there. Not hanging up costs the session. An ordinary blip is far
 * shorter than twenty seconds, and TCP rides it out.
 *
 * `ConnectTimeout` bounds a dial into the same hole, where the SYN or the
 * banner goes unanswered and the rung never returns. Ten seconds and not two,
 * because it covers the key exchange as well as the connect. The ladder's
 * total has to stay under the daemon's IDLE_EXIT_MS (shared/transport.ts
 * `delaysMs`), and this timeout does not threaten that: a dial costs the full
 * ten seconds only when the network is a hole, and a server behind a hole
 * never saw its client leave, so its idle clock is not running.
 */
const ALIVE_INTERVAL_S = 5;
const ALIVE_COUNT = 3;
const CONNECT_TIMEOUT_S = 10;

/**
 * How to start a server on the other machine: the argv, and the environment
 * that argv needs. Why each option, and the measurements behind them:
 * remote.md §4 for the host key and the two doors, §7 for the timeouts.
 *
 * The argv and the environment are returned together, since the password door
 * needs both. A caller that built the argv and forgot the environment would
 * produce an ssh that asks a helper that is not there.
 *
 * Every connection gets the same host-key options.
 * `StrictHostKeyChecking=yes` refuses an unknown host and a changed one, and
 * remembers neither. It refuses rather than asking, so no host-key question is
 * left for `BatchMode` to suppress. Ledge's own known_hosts comes first and
 * the user's second, so a host they already trust keeps working. Their entry
 * for a host is a pin too, and demanding they re-pin it teaches them to click
 * through pinning. `GlobalKnownHostsFile=/dev/null` keeps a system-wide file
 * out of the pin.
 *
 * `ServerAliveInterval`, `ServerAliveCountMax` and `ConnectTimeout` come first
 * on the argv and are not security. They carry ALIVE_INTERVAL_S, ALIVE_COUNT
 * and CONNECT_TIMEOUT_S, documented above.
 *
 * No `-t`. A remote pty would translate newlines in the byte stream, which is
 * fine for a shell and fatal for a length-prefixed protocol.
 *
 * A key or agent connection keeps `BatchMode=yes`. This ssh has no terminal
 * and its stdout is the protocol, so a passphrase prompt would either hang the
 * connection or write a question mark into a frame header.
 *
 * A password connection sends `BatchMode=no`. Under `BatchMode=yes` ssh
 * suppresses `SSH_ASKPASS` entirely, `SSH_ASKPASS_REQUIRE=force` included, so
 * the helper is never spawned and the dial fails with no password ever
 * offered. That is measured against a password-only sshd, and remote.md §4
 * used to claim the opposite. The three options beside it cover what
 * `BatchMode` was there for.
 */
export function sshDial(
  conn: Connection,
  files: { knownHosts: string; userKnownHosts: string; askpass: string },
): { argv: string[]; env: Record<string, string> } {
  const argv = [
    SSH_PATH,
    "-o",
    `ServerAliveInterval=${ALIVE_INTERVAL_S}`,
    "-o",
    `ServerAliveCountMax=${ALIVE_COUNT}`,
    "-o",
    `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${files.knownHosts} ${files.userKnownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
  ];
  // `-p` only when the connection names a port. An unset port leaves ssh to
  // its own configuration, so a `~/.ssh/config` alias keeps its own `Port`
  // (shared/connections.ts PORT_UNSET).
  if (conn.port !== PORT_UNSET) argv.push("-p", String(conn.port));

  const env: Record<string, string> = {};
  if (conn.auth === "password") {
    // `NumberOfPasswordPrompts=1` bounds the retries, keyboard-interactive
    // attempts included, since ssh counts those against it too.
    // `PubkeyAuthentication=no` stops a running agent from spending the
    // server's `MaxAuthTries` on keys before a password is tried.
    // `PreferredAuthentications` names both interactive methods, because many
    // sshd configurations answer with keyboard-interactive where this one
    // would say password. Nothing eats stdin: the helper answers on its own
    // descriptors, and the protocol comes up over the same connection.
    argv.push(
      "-o",
      "BatchMode=no",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
    );
    // `SSH_ASKPASS_REQUIRE=force` rather than a bare `SSH_ASKPASS`, which
    // OpenSSH ignores without a DISPLAY set. The account is a connection id
    // and not a secret. The password it names is read by the helper and never
    // by this process (bun/secrets.ts).
    env["SSH_ASKPASS"] = files.askpass;
    env["SSH_ASKPASS_REQUIRE"] = "force";
    env[ASKPASS_ACCOUNT_ENV] = conn.id;
  } else {
    argv.push("-o", "BatchMode=yes");
    if (conn.keyPath) {
      // `IdentitiesOnly=yes` goes with `-i`. Without it ssh offers every key
      // the agent holds before the one named here, which on a server with
      // `MaxAuthTries` can fail before it ever reaches the right one.
      argv.push("-i", conn.keyPath, "-o", "IdentitiesOnly=yes");
    }
  }

  argv.push(conn.destination, "ledge-server", "serve");
  return { argv, env };
}

/**
 * Lines that are equally true of a connection that went on to work, so none of
 * them is ever the fault: ssh's own narration, and the far end's `serve`
 * announcing that it attached to the daemon (bun/serve.ts, which logs to stderr
 * because stdout is the protocol).
 *
 * The banner is why this list exists. It is the last thing on stderr whenever
 * the dial succeeded and the protocol then failed. A handshake refused over the
 * version once reached the user as "Could not reach v1: [serve] ledge-server
 * 0.1.0 attached to …", which quoted a line saying the far end was up. The
 * transport's own verdict wins that case now (shared/transport.ts `Refused`),
 * and filtering the banner covers every later failure that has no wording of
 * its own.
 */
const NOT_A_FAULT = /^(Warning: Permanently added|Pseudo-terminal|Shared connection to|\[serve\] )/;

/**
 * Why the dial failed, out of what ssh and the remote shell said about it.
 *
 * The protocol cannot answer this. All of these failures happen before a frame
 * arrives, so the transport can only report "the connection to the server
 * closed", which is equally true of a missing binary, a refused key, a
 * firewall and a typo. ssh does know, and says so on stderr.
 *
 * The one line rewritten is `command not found`: that is the remote shell
 * reporting a local mistake, and a user who has not installed the server yet
 * needs the sentence that says so. Everything else is passed through as ssh
 * wrote it. "Permission denied (publickey)" and "No route to host" are already
 * the diagnosis.
 *
 * Null when there is nothing to add, which is what a server that accepted the
 * connection and then went quiet looks like from here.
 */
export function explainDial(stderr: string): string | null {
  // Last line first. ssh narrates (`Warning: Identity file … not accessible`)
  // and then fails, so the failure is the last thing it says.
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !NOT_A_FAULT.test(l));

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Every shell's way of saying it, since the remote's login shell is one
    // thing about a server this app never chose. bash and zsh say "command not
    // found", dash and ash say "not found", and zsh puts the name last.
    if (/(^|[: ])ledge-server: (command )?not found|command not found: ledge-server/.test(line)) {
      // No connection name in the sentence. Every caller already names the
      // connection, on the row or in front of this text, and repeating it
      // reads as two machines rather than one.
      return "Ledge's server is not installed on that machine. Install it there, then try again.";
    }
    return line;
  }
  return null;
}

/** Ledge's known_hosts: the pinned lines, one per connection that has one. */
export function knownHostsText(connections: readonly Connection[]): string {
  const lines = connections.map((c) => c.hostKey.trim()).filter((line) => line.length > 0);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * The host key to pin, out of `ssh-keyscan` output. The preference order below
 * is the order ssh itself prefers, so the key pinned is the one a connection
 * will actually be offered. Scanning returns every type the host serves, and
 * pinning an ed25519 key while ssh negotiates rsa would refuse every
 * connection with a message about a changed host key.
 *
 * Comment lines (`# host:22 SSH-2.0-OpenSSH_9.6`) are keyscan's banner report,
 * not keys. Null when there is nothing usable, which is what an unreachable
 * host looks like from here.
 */
const KEY_PREFERENCE = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"];

export function pickHostKey(keyscanOutput: string): string | null {
  const lines = keyscanOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && l.split(/\s+/).length >= 3);
  for (const type of KEY_PREFERENCE) {
    const found = lines.find((l) => l.split(/\s+/)[1] === type);
    if (found) return found;
  }
  return lines[0] ?? null;
}

/**
 * The fingerprint out of `ssh-keygen -lf`: `256 SHA256:abc… host (ED25519)`.
 * A user compares this against what the server told them, so both halves that
 * identify the key come back (the hash and the algorithm) and nothing else
 * does.
 */
export function parseFingerprint(keygenOutput: string): { fingerprint: string; keyType: string } | null {
  const parts = keygenOutput.trim().split(/\s+/);
  const hash = parts.find((p) => p.startsWith("SHA256:") || p.startsWith("MD5:"));
  if (!hash) return null;
  const bracketed = /\(([^)]+)\)\s*$/.exec(keygenOutput.trim())?.[1] ?? "";
  return { fingerprint: hash, keyType: bracketed };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// --- the file ----------------------------------------------------------------

/** The user's own known_hosts, the second file ssh is pointed at. */
export function userKnownHosts(): string {
  return join(homedir(), ".ssh", "known_hosts");
}

export async function loadConnections(): Promise<{ connections: Connection[]; selected: string }> {
  try {
    return parseConnections(JSON.parse(await readFile(CONNECTIONS_PATH, "utf8")));
  } catch {
    // No file yet, or one that cannot be read: the local server, selected.
    return { connections: [], selected: LOCAL_ID };
  }
}

/**
 * The list on disk, plus Ledge's known_hosts re-rendered from it.
 *
 * The known_hosts file is a projection of these records, never an input, so
 * the two are written together: removing a connection removes its pin, and a
 * hand-edited pin does not outlive the connection it belonged to. Both writes
 * are atomic, like every other write in the app home, so a crash leaves either
 * the old list or the new one.
 */
export async function saveConnections(connections: readonly Connection[], selected: string): Promise<void> {
  await ensureClientHome();
  const stored: Stored = { version: 1, selected, connections: [...connections] };
  await atomically(CONNECTIONS_PATH, `${JSON.stringify(stored, null, 2)}\n`);
  await atomically(KNOWN_HOSTS_PATH, knownHostsText(connections));
}

async function atomically(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

/**
 * A host's key and a description of it, for the fingerprint the user compares
 * during pairing (remote.md §4). Two spawns, both of them ssh's own tools:
 * Ledge parses no key material and computes no hash of its own.
 *
 * Failure comes back as data rather than an exception. An unreachable host at
 * pairing time is ordinary, and it has to reach the user as a sentence.
 */
export async function probeHostKey(
  destination: string,
  port: number = PORT_UNSET,
): Promise<{ hostKey: string; fingerprint: string; keyType: string } | { error: string }> {
  if (!isHostName(destination)) return { error: `"${destination}" is not an ssh destination.` };
  if (port !== PORT_UNSET && !isPort(port)) return { error: `${port} is not a port.` };
  let scanned: string;
  try {
    // -T bounds the wait. A firewalled host would otherwise leave the dialog
    // spinning with nothing to say.
    //
    // -p when the connection names a port, because the line keyscan prints is
    // the line that gets pinned. With a port it comes back as `[host]:port`,
    // which is the shape ssh looks for at connect time (shared/connections.ts
    // knownHostsHost).
    const argv = [KEYSCAN_PATH, "-T", "5"];
    if (port !== PORT_UNSET) argv.push("-p", String(port));
    argv.push(hostPart(destination));
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    scanned = await new Response(p.stdout).text();
    await p.exited;
  } catch (err) {
    return { error: `Could not run ssh-keyscan (${err instanceof Error ? err.message : String(err)}).` };
  }
  const hostKey = pickHostKey(scanned);
  if (!hostKey) {
    // The port is named when there is one: "no answer from vps" and "no answer
    // from vps on 2222" send someone to two different places to look.
    const where = port === PORT_UNSET ? hostPart(destination) : `${hostPart(destination)} on port ${port}`;
    return { error: `No answer from ${where}. Check the address, and that ssh is running there.` };
  }
  try {
    const p = Bun.spawn([KEYGEN_PATH, "-lf", "-"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    p.stdin.write(`${hostKey}\n`);
    await p.stdin.end();
    const described = parseFingerprint(await new Response(p.stdout).text());
    await p.exited;
    if (!described) return { error: "That host answered with a key ssh-keygen could not describe." };
    return { hostKey, ...described };
  } catch (err) {
    return { error: `Could not run ssh-keygen (${err instanceof Error ? err.message : String(err)}).` };
  }
}
