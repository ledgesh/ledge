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
import { hostPart } from "../shared/connections";
import { CLIENT_HOME, ensureClientHome } from "./clientHome";

// The half of a connection that is a fact about ssh rather than about this
// machine's files, re-exported so that "what a connection is" still has one
// import path on this side. The phone reaches the same functions directly,
// because it has no Bun to reach them through (shared/connections.ts).
export { hostPart, pinFitsHost, pinnedHost, validateConnection } from "../shared/connections";

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

/** The id of the server in this process. Reserved, never minted, never stored. */
export const LOCAL_ID = "local";

export interface Connection {
  id: string;
  name: string;
  /** An ssh destination (`host`, `user@host`, a ~/.ssh/config alias), or "" for
   * the server in this process. */
  destination: string;
  /** A private key to offer, or "" to let ssh's own configuration decide. */
  keyPath: string;
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
  keyPath: "",
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
  return {
    id,
    name,
    destination,
    keyPath: str(raw["keyPath"]),
    hostKey: str(raw["hostKey"]),
    lastReached: typeof raw["lastReached"] === "number" && raw["lastReached"] > 0 ? raw["lastReached"] : 0,
  };
}

/**
 * The argv that starts a server on the other machine.
 *
 * The four options are the whole security posture of the transport, and none
 * of them is a default worth inheriting:
 *
 * - `BatchMode=yes` because this ssh has no terminal. Its stdout IS the
 *   protocol, so a passphrase or a "continue?" prompt would either hang the
 *   connection forever or write a question mark into a frame header.
 * - `StrictHostKeyChecking=yes` because the alternative is the blind accept
 *   remote.md §4 rules out. An unknown host is refused, a changed one is
 *   refused, and neither is remembered.
 * - Ledge's own known_hosts FIRST, then the user's. What Ledge pinned lives in
 *   a file that can be inspected and revoked on its own; what the user already
 *   trusts keeps working, because their known_hosts entry is a pin too and
 *   demanding they re-pin would teach them to click through pinning.
 * - `GlobalKnownHostsFile=/dev/null` because a system-wide file is a third
 *   party to the pin, and this is the one place worth being pedantic.
 *
 * No `-t`. A remote pty would translate newlines in the byte stream, which is
 * fine for a shell and fatal for a length-prefixed protocol.
 */
export function sshCommand(conn: Connection, knownHosts: string, userKnownHosts: string): string[] {
  const argv = [
    SSH_PATH,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHosts} ${userKnownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
  ];
  if (conn.keyPath) {
    // IdentitiesOnly with it: without that, ssh offers every key the agent
    // holds before the one that was named, which on a server with
    // MaxAuthTries can fail before it ever gets to the right one.
    argv.push("-i", conn.keyPath, "-o", "IdentitiesOnly=yes");
  }
  argv.push(conn.destination, "ledge-server", "serve");
  return argv;
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
): Promise<{ hostKey: string; fingerprint: string; keyType: string } | { error: string }> {
  if (!isHostName(destination)) return { error: `"${destination}" is not an ssh destination.` };
  let scanned: string;
  try {
    // -T bounds the wait: a host that is merely firewalled otherwise leaves
    // the dialog spinning with nothing to say.
    const p = Bun.spawn([KEYSCAN_PATH, "-T", "5", hostPart(destination)], { stdout: "pipe", stderr: "ignore" });
    scanned = await new Response(p.stdout).text();
    await p.exited;
  } catch (err) {
    return { error: `Could not run ssh-keyscan (${err instanceof Error ? err.message : String(err)}).` };
  }
  const hostKey = pickHostKey(scanned);
  if (!hostKey) {
    return { error: `No answer from ${hostPart(destination)}. Check the address, and that ssh is running there.` };
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
