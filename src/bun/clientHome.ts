// The client's own corner of disk, and the id it is known by.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { APP_HOME } from "./workspaces";

export const CLIENT_HOME = join(APP_HOME, ".client");

// The id file is deliberately its own file and not a key in connections.json:
// it is the name the SERVER files this client's layout under (remote.md §5),
// so a connections file that gets corrupted or hand-deleted must not take the
// id with it and orphan a saved arrangement.
export const CLIENT_ID_PATH = join(CLIENT_HOME, "id");

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
    // its answer rather than overwriting it. Two windows on one machine are one
    // client and must file their layout under one key.
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
