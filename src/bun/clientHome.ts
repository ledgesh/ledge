// The client's files on disk, and the ids this client is known by, one per
// server it connects to. A window is a client, and identity follows the
// connection it points at (remote.md §8a). remote.md §5 splits state by
// machine. This module owns the half that describes the screen. Nothing here
// is served over the wire, and bun/server.ts does not import it.
//
// The files live at `.client` inside the app home rather than in a second
// top-level directory. remote.md §5 gives the reason, along with what deriving
// the path from APP_HOME does for a scratch probe. The name is dotted like the
// registry and the vault beside it, so no folder listing shows it and no
// workspace slug can collide with it.
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { LOCAL_ID } from "../shared/connections";
import { APP_HOME } from "./workspaces";

export const CLIENT_HOME = join(APP_HOME, ".client");

// The id lives in its own file rather than as a key in connections.json. It is
// the name the server files this client's layout under (remote.md §5), so a
// connections file that gets corrupted or hand-deleted must not take the id
// with it and orphan a saved arrangement.
//
// It holds the local connection's id now that a window is a client (remote.md
// §8a). An install upgrading across that change keeps the layout it already
// has: the id this file has always held still names the server the app has
// always started on.
export const CLIENT_ID_PATH = join(CLIENT_HOME, "id");

// The ids used on the other servers, keyed by connection. It is a separate
// file for the reason CLIENT_ID_PATH is, applied to the whole set: these are
// the names N servers file N arrangements under, and a hand-edited connections
// file must not orphan them all at once.
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
// without a registry to consult. Ids are validated on read rather than
// trusted. The string becomes a key in a file the server writes, so a
// hand-edited newline or an empty file must not become one.
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClientId(text: string): boolean {
  return ID_SHAPE.test(text);
}

let cached: string | null = null;

/**
 * This client's id, minted on first launch and kept from then on.
 *
 * Cached for the process: it is read at boot and handed to the server on every
 * layout call, and re-reading a file that does not change would cost a syscall
 * per save. A client that cannot write the file still gets a working id for
 * this run. That loses the saved layout at the next launch, which is a smaller
 * failure than refusing to open a window.
 */
export async function clientId(): Promise<string> {
  if (cached !== null) return cached;
  const existing = await readId();
  if (existing !== null) return (cached = existing);

  const minted = crypto.randomUUID();
  try {
    await ensureClientHome();
    // "wx" first, so a second process that already minted an id keeps it: the
    // write fails and the catch below reads that id instead of overwriting it.
    await writeFile(CLIENT_ID_PATH, `${minted}\n`, { encoding: "utf8", flag: "wx" });
  } catch {
    const raced = await readId();
    if (raced !== null) return (cached = raced);
    // The file exists and holds no id: truncated, hand-edited, or restored
    // half way by a sync client. That is garbage rather than another process's
    // answer, and leaving it costs a fresh id at every launch and the saved
    // layout with it. Overwrite it, and run on the minted id unsaved if that
    // write fails too.
    await writeFile(CLIENT_ID_PATH, `${minted}\n`, "utf8").catch(() => {});
  }
  return (cached = minted);
}

/**
 * The id this client is known by on `connection` (remote.md §8a).
 *
 * Identity follows the connection rather than the window, so selecting a
 * server again brings back the arrangement left on it. The id is minted the
 * first time a connection is opened and kept until `forgetClientId` drops it
 * with the connection. The local connection uses the machine id above rather
 * than an entry here, so an install upgrading across §8a keeps the layout it
 * has.
 *
 * Best-effort like the machine id: a map that cannot be written costs that
 * server's arrangement at the next launch, and the window still opens.
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
 * Drop the id for a connection that is gone. This is what bounds the file to
 * one entry per connection rather than one per window ever opened.
 *
 * The layout still filed under that id on the server is that server's to
 * prune. It is the same orphan a phone that never comes back already leaves
 * (remote.md §5).
 */
export async function forgetClientId(connection: string): Promise<void> {
  const known = await clientMap();
  if (!(connection in known)) return;
  delete known[connection];
  await saveClientMap(known);
}

/**
 * An id for a window whose layout must not be filed anywhere: the second
 * window on a connection another window is already holding (remote.md §8a).
 *
 * Two windows cannot both be the client one server files one layout under, so
 * the second is a client the server has never met, for as long as it is open.
 * The id is a real one: it takes a drawer and gets a row in `presence` the way
 * any other window does. It is never written down.
 */
export function ephemeralClientId(): string {
  return crypto.randomUUID();
}

/**
 * The stored map, self-healing. Machine-written state (architecture.md §6):
 * an entry that is not a connection id against a well-formed client id is
 * dropped, and a file that does not parse at all means "no ids yet". The cost
 * is saved arrangements, never the launch.
 */
export function parseClientMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [connection, id] of Object.entries(raw as Record<string, unknown>)) {
    // The empty string names no connection. The local server's id lives in its
    // own file, so an entry under LOCAL_ID could only shadow it.
    if (connection === "" || connection === LOCAL_ID) continue;
    if (typeof id === "string" && isClientId(id)) out[connection] = id;
  }
  return out;
}

/**
 * What this Mac calls itself, for the presence list on every other client
 * connected to the same server (wire.ts `Hello.label`).
 *
 * It is the hostname. The machine already has a name, and asking the user for
 * a second one would leave them keeping two in sync. `.local` comes off:
 * Bonjour appends it to every Mac on the network, so it says nothing about
 * which one this is.
 *
 * Not cached here and not written down. The label is allowed to change, unlike
 * the id. Nothing is filed under it, so a rename orphans nothing.
 * (bun/index.ts reads it once at launch, so a rename shows at the next one.)
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
// the old map or the new one. The cache is updated even when the write fails.
// An id that could not be saved still has to be the id this session uses, or
// two windows on one connection would disagree about who they are.
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
