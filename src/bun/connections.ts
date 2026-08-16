// Which server this client talks to (remote.md §8).
//
// A connection is CLIENT-side configuration: a display name, an ssh
// destination, a key to offer, the host key pinned when it was added, and when
// it was last reached. Nothing about it is stored on a server, so a server has
// no opinion about who connects to it, and moving this app to another Mac
// carries the list without touching any notes.
//
// One at a time. Switching tears the session down and rebuilds it (§8), which
// is what makes "everything workspace-scoped becomes server-scoped" true
// without a scoping rule: there is only ever one server's registry, search,
// tags and trash in the process at once.
//
// The local server is a connection too, and not a stored one — it is always
// present, cannot be edited, and cannot be removed. Keeping it in the same
// list is what stops "no connection configured" from being a state the app
// has to render, and it is the same claim §1 makes about the transport: the
// local case is not special, only cheaper.
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isHostName } from "../shared/frontmatter";
import { hostPart, isPort, LOCAL_ID, parseAuth, PORT_UNSET, type AuthMode } from "../shared/connections";
import { CLIENT_HOME, ensureClientHome } from "./clientHome";
import { ASKPASS_ACCOUNT_ENV } from "./secrets";

// The half of a connection that is a fact about ssh rather than about this
// machine's files, re-exported so that "what a connection is" still has one
// import path on this side. The phone reaches the same functions directly,
// because it has no Bun to reach them through (shared/connections.ts).
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

// Ledge's own known_hosts, written from the records below at every connect.
// Its own file so that what Ledge pinned is legible and revocable on its own,
// without editing the file every other ssh on the machine depends on.
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
   * the server in this process. Never a `host:port` — the port is its own
   * field, because that is what ssh takes and what every other client's form
   * asks for separately. */
  destination: string;
  /** Where sshd listens, or PORT_UNSET to let ssh decide — which is what keeps
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
 * anything that does not parse costs exactly itself, and total failure means
 * "only the local server", which is a working app rather than an error dialog
 * over a file no human edits.
 *
 * A stored entry claiming the local id is dropped: that id names the server in
 * this process, and a stored one wearing it could shadow the connection that
 * must always be reachable.
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
  // A selection naming nothing falls back to the local server rather than to
  // an arbitrary neighbour: booting into the wrong machine is the one failure
  // remote.md §8 spends a paragraph on.
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
    // A port that is not one costs itself and not the record: the connection
    // still opens, on whatever ssh decides, which is where every record written
    // before this field existed already opens.
    port: typeof port === "number" && isPort(port) ? port : PORT_UNSET,
    keyPath: str(raw["keyPath"]),
    // Anything that is not the password door is the key door, which is where
    // every record written before this field existed already opens.
    auth: parseAuth(raw["auth"]),
    hostKey: str(raw["hostKey"]),
    lastReached: typeof raw["lastReached"] === "number" && raw["lastReached"] > 0 ? raw["lastReached"] : 0,
  };
}

/**
 * How long a silent wire stays undetected, and what bounds a dial into one.
 *
 * ssh sends a keepalive after `ALIVE_INTERVAL_S` with nothing received, and
 * hangs up once `ALIVE_COUNT` of them go unanswered — about twenty seconds
 * here. Both are off by default, and the default is what a black hole exploits:
 * a wire that stops carrying bytes without closing (wifi gone, a laptop moved
 * between networks, a middlebox that dropped the flow) sends no FIN and no RST,
 * so the ssh process has nothing to notice. `TCPKeepAlive` does not save it —
 * macOS first probes an idle socket after two HOURS — which leaves the whole
 * reconnect apparatus in `shared/transport.ts` armed by an event that never
 * arrives. The app goes on saying it is connected, and every request sits
 * pending forever. `scripts/probe-ssh.ts` cuts a real wire and measures this.
 *
 * Twenty seconds is chosen against what each mistake costs, which is nothing
 * like symmetric. Hanging up on a link that was merely stalled costs a
 * reconnect: the ladder re-dials, the in-flight requests replay under their own
 * op ids, the server is the same instance and the sessions are still there. Not
 * hanging up costs the session entirely. So this is deliberately far more eager
 * than ssh's own suggested 45s, and still long enough that an ordinary blip —
 * which TCP rides out without help — is never noticed at all.
 *
 * `ConnectTimeout` bounds the other half. Dialling INTO a black hole hangs the
 * same way: the SYN or the banner goes unanswered, and a rung of the ladder
 * that never returns is a ladder with one rung. It covers the kex as well as
 * the connect, which is why it is ten seconds and not two. Doing this does not
 * break the ladder's rule about outrunning the daemon's IDLE_EXIT_MS: a dial
 * only costs the full timeout when the network is a hole, and a server on the
 * far side of a hole never saw its client leave, so its idle clock is not
 * running.
 */
const ALIVE_INTERVAL_S = 5;
const ALIVE_COUNT = 3;
const CONNECT_TIMEOUT_S = 10;

/**
 * How to start a server on the other machine: the argv, and the environment
 * that argv needs.
 *
 * Both together because the password door is half of each, and a caller that
 * built the argv and forgot the environment would produce an ssh that asks a
 * helper that is not there.
 *
 * These options are the whole security posture of the transport, and none of
 * them is a default worth inheriting:
 *
 * - `StrictHostKeyChecking=yes` because the alternative is the blind accept
 *   remote.md §4 rules out. An unknown host is refused, a changed one is
 *   refused, and neither is remembered. It is also what makes the password
 *   door affordable below: it refuses OUTRIGHT rather than asking, so there is
 *   no host-key question left for `BatchMode` to have to suppress.
 * - Ledge's own known_hosts FIRST, then the user's. What Ledge pinned lives in
 *   a file that can be inspected and revoked on its own; what the user already
 *   trusts keeps working, because their known_hosts entry is a pin too and
 *   demanding they re-pin would teach them to click through pinning.
 * - `GlobalKnownHostsFile=/dev/null` because a system-wide file is a third
 *   party to the pin, and this is the one place worth being pedantic.
 *
 * `ServerAliveInterval`, `ServerAliveCountMax` and `ConnectTimeout` sit ahead
 * of those on the argv and are not security at all. They are the difference
 * between the reconnect ladder running and merely existing; the block above
 * says why.
 *
 * No `-t`. A remote pty would translate newlines in the byte stream, which is
 * fine for a shell and fatal for a length-prefixed protocol.
 *
 * **The two doors differ from here down.**
 *
 * A key or agent connection keeps `BatchMode=yes`: this ssh has no terminal,
 * its stdout IS the protocol, and a passphrase prompt would either hang the
 * connection forever or write a question mark into a frame header.
 *
 * A password connection cannot. `BatchMode=yes` suppresses `SSH_ASKPASS`
 * entirely, `SSH_ASKPASS_REQUIRE=force` included, so the helper is never
 * spawned and the connection fails without a password ever being offered
 * (measured; remote.md §4). What `BatchMode` was buying is bought by narrower
 * options instead, which is what makes turning it off affordable:
 *
 * - The host-key question is already refused rather than asked, above.
 * - `NumberOfPasswordPrompts=1` bounds the retries, which is the other half of
 *   what a batch mode is for. It covers keyboard-interactive as well as
 *   password, because ssh counts both attempts against it.
 * - Nothing can eat stdin. The helper answers on its own descriptors, and the
 *   protocol's bytes pass through untouched.
 *
 * `PubkeyAuthentication=no` so that a running agent does not spend the
 * server's `MaxAuthTries` offering keys before a password is tried, and
 * `PreferredAuthentications` naming both interactive methods because a great
 * many sshd configurations answer with keyboard-interactive where this one
 * would say password.
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
  // Only when the connection names one. An unset port leaves ssh to its own
  // configuration, which is what lets a `~/.ssh/config` alias carry its own
  // `Port` (shared/connections.ts PORT_UNSET).
  if (conn.port !== PORT_UNSET) argv.push("-p", String(conn.port));

  const env: Record<string, string> = {};
  if (conn.auth === "password") {
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
    // `force` rather than a bare SSH_ASKPASS, which OpenSSH would ignore
    // without a DISPLAY set. The account is a connection id and not a secret;
    // what it names is read by the helper and never by this process
    // (bun/secrets.ts).
    env["SSH_ASKPASS"] = files.askpass;
    env["SSH_ASKPASS_REQUIRE"] = "force";
    env[ASKPASS_ACCOUNT_ENV] = conn.id;
  } else {
    argv.push("-o", "BatchMode=yes");
    if (conn.keyPath) {
      // IdentitiesOnly with it: without that, ssh offers every key the agent
      // holds before the one that was named, which on a server with
      // MaxAuthTries can fail before it ever gets to the right one.
      argv.push("-i", conn.keyPath, "-o", "IdentitiesOnly=yes");
    }
  }

  argv.push(conn.destination, "ledge-server", "serve");
  return { argv, env };
}

/**
 * Why the dial failed, out of what ssh and the remote shell said about it.
 *
 * The protocol cannot answer this. Every one of these failures happens before
 * a single frame arrives, so all the transport can report is that a wire it
 * never had is gone — "the connection to the server closed", which is true of
 * a missing binary, a refused key, a firewall and a typo alike, and tells
 * somebody looking at a fresh server none of the four apart.
 *
 * ssh does know, and says so on stderr. So this reads that, and the ONLY case
 * it rewrites is the one where ssh's own words point at the wrong machine:
 * `command not found` is the remote shell reporting a local mistake, and a
 * user who has not installed the server yet needs the sentence that says so
 * rather than a shell's name for it. Everything else is passed through as ssh
 * wrote it, because ssh is better at this than a table of guesses would be —
 * "Permission denied (publickey)" and "No route to host" are the diagnoses,
 * not the raw material for one.
 *
 * Null when there is nothing to add, which is what a server that accepted the
 * connection and then went quiet looks like from here.
 */
export function explainDial(stderr: string): string | null {
  // Last first: ssh narrates (`Warning: Identity file … not accessible`) and
  // then fails, and the failure is the last thing it says. Banners and the
  // pseudo-terminal notice are dropped for the same reason — they are true of
  // connections that went on to work.
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(Warning: Permanently added|Pseudo-terminal|Shared connection to)/.test(l));

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Every shell's way of saying it, because the remote's login shell is the
    // one thing about a server this app never chose: bash and zsh say "command
    // not found", dash and ash say "not found", and zsh puts the name last.
    if (/(^|[: ])ledge-server: (command )?not found|command not found: ledge-server/.test(line)) {
      // No name in it: every caller of this already names the connection, on
      // the row or in front of the sentence, and a message that repeats it
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
 * The host key to pin, out of `ssh-keyscan` output. Preference order is the
 * order ssh itself prefers, so the key pinned is the one a connection will
 * actually be offered; scanning returns every type the host serves, and
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
 * This is the string a user compares against what the server told them, so
 * both halves that identify the key travel — the hash and the algorithm — and
 * nothing else does.
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
 * Persist the list, and re-render Ledge's known_hosts from it.
 *
 * The two are written together on purpose: the known_hosts file is a
 * projection of these records, never an input, so removing a connection
 * removes its pin in the same breath and a hand-edited pin does not outlive
 * the connection it belonged to. Atomic, like every other write in the app
 * home, so a crash leaves the old list or the new one.
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
 * Ask a host for its key and describe it, for the confirmation a pairing needs
 * (remote.md §4). Two spawns, both of them ssh's own tools: Ledge parses no
 * key material and computes no hash of its own.
 *
 * Failure is data, not an exception — an unreachable host at pairing time is
 * the most ordinary outcome there is, and it has to reach the user as a
 * sentence.
 */
export async function probeHostKey(
  destination: string,
  port: number = PORT_UNSET,
): Promise<{ hostKey: string; fingerprint: string; keyType: string } | { error: string }> {
  if (!isHostName(destination)) return { error: `"${destination}" is not an ssh destination.` };
  if (port !== PORT_UNSET && !isPort(port)) return { error: `${port} is not a port.` };
  let scanned: string;
  try {
    // -T bounds the wait: a host that is merely firewalled otherwise leaves
    // the dialog spinning with nothing to say.
    //
    // -p when the connection names one, because the line keyscan prints is the
    // line that gets pinned: with a port it comes back as `[host]:port`, which
    // is the shape ssh will look for at connect time (shared/connections.ts
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
