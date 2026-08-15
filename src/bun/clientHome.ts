// The client's own corner of disk, and the ids it is known by — one per server
// it connects to, because a window is a client and identity follows the
// connection it points at (remote.md §8a).
//
// remote.md §5 splits state by machine as well as by lifetime: the notes, the
// registry, the vault, and the shells belong to the server, while the window's
// position, the font sizes, and the list of servers to connect to are facts
// about the screen in front of you. This module owns the second kind. Nothing
// here is ever served over the wire, and bun/server.ts does not import it.
//
// It lives at `.client` inside the app home rather than in a second top-level
// directory. On every machine Ledge ships to, the client and its local server
// are the same user on the same disk, so one `~/.ledge` to back up beats two;
// dotted, like every other app-owned entry there, so no folder listing shows
// it and no workspace slug can collide with it. Deriving it from APP_HOME also
// means LEDGE_NOTES_ROOT moves the client's files too, which is what lets a
// scratch probe run without touching the real ones.
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { LOCAL_ID } from "../shared/connections";
import { APP_HOME } from "./workspaces";

export const CLIENT_HOME = join(APP_HOME, ".client");

// The id file is deliberately its own file and not a key in connections.json:
// it is the name the SERVER files this client's layout under (remote.md §5),
// so a connections file that gets corrupted or hand-deleted must not take the
// id with it and orphan a saved arrangement.
//
// It is the LOCAL connection's id now that a window is a client (remote.md
// §8a), which is what carries an install across that change with the layout it
// already has: the one id this file has always held keeps naming the one server
// this app has always started on.
export const CLIENT_ID_PATH = join(CLIENT_HOME, "id");

// And the id used on each of the others, keyed by connection. Its own file for
// CLIENT_ID_PATH's reason applied to the whole set: these are the names N
// servers file N arrangements under, and a hand-edited connections file must
// not be able to orphan them all at once.
export const CLIENT_MAP_PATH = join(CLIENT_HOME, "clients.json");

export async function ensureClientHome(): Promise<void> {
  await mkdir(CLIENT_HOME, { recursive: true });
}

// Sync for the one caller that has no choice: the window frame is written from
// a process-exit hook, where a promise never resolves (bun/windowFrame.ts).
export function ensureClientHomeSync(): void {
  mkdirSync(CLIENT_HOME, { recursive: true });
}

// An id is opaque and only has to be unique and stable, which a v4 UUID is
// without a registry to consult. Validated on read rather than trusted: this
// string becomes a key in a file the server writes, so a hand-edited newline
// or an empty file must not become one.
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClientId(text: string): boolean {
  return ID_SHAPE.test(text);
}

let cached: string | null = null;

/**
 * This client's id, minted on first launch and kept forever.
 *
 * Cached for the process: it is read on the boot path and then handed to the
 * server on every layout call, and re-reading a file that cannot change under
 * us would be a syscall per save.
 *
 * A client that cannot write the file still gets a working id for this run —
 * losing the saved layout at the next launch is a far smaller failure than
 * refusing to open a window over it.
 */
export async function clientId(): Promise<string> {
  if (cached !== null) return cached;
  const existing = await readId();
  if (existing !== null) return (cached = existing);

  const minted = crypto.randomUUID();
  try {
    await ensureClientHome();
    // "wx" first: a second process that raced us to mint one wins, and we take
    // its answer rather than overwriting it.
    await writeFile(CLIENT_ID_PATH, `${minted}\n`, { encoding: "utf8", flag: "wx" });
  } catch {
    const raced = await readId();
    if (raced !== null) return (cached = raced);
    // The file exists and holds no id — truncated, hand-edited, restored half
    // by a sync client. That is not another process's answer, it is garbage,
    // and leaving it costs a fresh id at every launch and the saved layout
    // with it. Overwrite; failing that, run on the minted id unsaved.
    await writeFile(CLIENT_ID_PATH, `${minted}\n`, "utf8").catch(() => {});
  }
  return (cached = minted);
}

/**
 * The id this client is known by ON `connection` (remote.md §8a).
 *
 * Identity follows the connection and not the window, which is the whole of
 * what makes a re-selected server come back with the arrangement left on it: a
 * layout is three panes of THAT machine's notes, and it means nothing in front
 * of another machine's. Minted the first time a connection is opened and kept
 * until `forgetClientId` drops it with the connection itself.
 *
 * The local server's is the machine id above rather than an entry here, so an
 * install upgrading across §8a keeps the layout it has.
 *
 * Best-effort like the machine id, and for the same reason: a map that cannot
 * be written costs the NEXT launch that server's arrangement, which is a far
 * smaller failure than refusing to open the window over it.
 */
export async function clientIdFor(connection: string): Promise<string> {
  if (connection === LOCAL_ID) return clientId();
  const known = await clientMap();
  const existing = known[connection];
  if (existing !== undefined) return existing;
  const minted = crypto.randomUUID();
  known[connection] = minted;
  await saveClientMap(known);
  return minted;
}

/**
 * Drop the id for a connection that is gone, which is what bounds this file:
 * one entry per connection rather than one per window ever opened.
 *
 * The layout still filed under it on that server is that server's to prune, and
 * is the same orphan a phone that never comes back already leaves (remote.md
 * §5).
 */
export async function forgetClientId(connection: string): Promise<void> {
  const known = await clientMap();
  if (!(connection in known)) return;
  delete known[connection];
  await saveClientMap(known);
}

/**
 * An id for a window that must not be filed under anything: the second window
 * on a connection another window is already holding (remote.md §8a).
 *
 * Two windows cannot both be the client one server files one layout under, so
 * the second is a client the server has never met, for as long as it is open.
 * It is a real id — the drawer it takes and the row it gets in `presence` are
 * as real as any other window's — and it is simply never written down.
 */
export function ephemeralClientId(): string {
  return crypto.randomUUID();
}

/**
 * The stored map, self-healing. Machine-written state (architecture.md §6):
 * anything that is not a connection id against a well-formed client id is
 * dropped, and a file that does not parse at all means "no ids yet", which
 * costs saved arrangements and never the launch.
 */
export function parseClientMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [connection, id] of Object.entries(raw as Record<string, unknown>)) {
    // The local server's id lives in its own file; an entry claiming that key
    // could only shadow it.
    if (connection === "" || connection === LOCAL_ID) continue;
    if (typeof id === "string" && isClientId(id)) out[connection] = id;
  }
  return out;
}

/**
 * What this Mac calls itself, for the presence list on every other client
 * connected to the same server (wire.ts `Hello.label`).
 *
 * The hostname, because the machine already has a name and asking the user for
 * a second one would be asking them to keep two in sync. `.local` comes off:
 * it is what Bonjour appends to every Mac on the network and it says nothing
 * about which one this is.
 *
 * Not cached and not written down. Unlike the id, this is allowed to change —
 * rename the Mac and the next connection says so — and nothing is filed under
 * it, so nothing is orphaned when it does.
 */
export function clientLabel(): string {
  return hostname().replace(/\.local$/i, "");
}

async function readId(): Promise<string | null> {
  try {
    const text = (await readFile(CLIENT_ID_PATH, "utf8")).trim();
    return isClientId(text) ? text : null;
  } catch {
    return null;
  }
}

// Cached for the process, like the id: every window reads it at boot and at
// every switch, and it can only change through this module.
let ids: Record<string, string> | null = null;

async function clientMap(): Promise<Record<string, string>> {
  if (ids !== null) return ids;
  try {
    return (ids = parseClientMap(JSON.parse(await readFile(CLIENT_MAP_PATH, "utf8"))));
  } catch {
    return (ids = {});
  }
}

// Temp-plus-rename like every other write in the app home, so a crash leaves
// the old map or the new one. The cache is updated either way: an id that could
// not be saved still has to be the id this session uses, or two windows on one
// connection would disagree about who they are.
async function saveClientMap(next: Record<string, string>): Promise<void> {
  ids = next;
  try {
    await ensureClientHome();
    const tmp = `${CLIENT_MAP_PATH}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmp, CLIENT_MAP_PATH);
  } catch (err) {
    console.warn(`[client] could not save the connection ids (${err})`);
  }
}
