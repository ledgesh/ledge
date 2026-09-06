// The Bun end of session persistence: .layout.json in the app home, holding
// which workspaces exist, their pane trees, and which notes are open where.
// One file covers all workspaces, because it records the workspace list
// itself. It is dotted and lives in the app home, so no listing shows it.
//
// Keyed by client id (remote.md §5), which arrives with the connection
// rather than with each call (shared/wire.ts Hello). Bun owns the map: which
// client, and the atomic write. The ownership line stops there. The view
// owns each value's shape and discards a corrupt one at parse time
// (workspace/persist.ts), so the text here is the view's and stays opaque.
import { basename, join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { APP_HOME, ensureAppHome } from "./workspaces";

export const LAYOUT_PATH = join(APP_HOME, ".layout.json");

// The key for a client that sends no id, and for one whose id is not a plain
// id. A client with no layout of its own to keep may connect without one
// (shared/wire.ts Hello), and the server files it here rather than refusing
// the connection. Two such clients then share one arrangement. That is
// better than neither of them restoring anything.
const ANONYMOUS = "_";

// True when the file is the old single layout, written before the per-client
// keys. The view stamps a `version` into its own shape
// (workspace/persist.ts), and a map of client ids has none at the top level.
// The check is a heuristic: a client whose id is literally "version" passes
// it too. An install upgrading across the split has exactly one arrangement
// saved and exactly one client asking for it, so the first reader adopts it.
function adoptable(parsed: unknown): boolean {
  return typeof parsed === "object" && parsed !== null && "version" in (parsed as Record<string, unknown>);
}

/**
 * This client's saved layout as raw text, or null when it has none: first
 * launch, a new client, or a file that cannot be read. None of them are
 * distinguished: each means the caller boots fresh. The view's parser handles
 * everything else.
 */
export async function readLayout(client: string): Promise<string | null> {
  const parsed = await readFileJson();
  if (parsed === null) return null;
  if (adoptable(parsed)) return JSON.stringify(parsed);
  const mine = (parsed as Record<string, unknown>)[key(client)];
  return mine === undefined ? null : JSON.stringify(mine);
}

/**
 * Persist this client's layout, returning false (with a warning) when `text`
 * is not JSON. Two guards, one on each side of the trust boundary. The text
 * must parse as JSON, so this RPC cannot store arbitrary view-supplied bytes
 * under a fixed name in the folder people sync. The write is the same
 * temp-plus-rename as a note save, so a crash mid-write leaves the old layout
 * or the new one, never half.
 *
 * Read-modify-write, because the file holds other clients' arrangements too.
 * There is no lock: the writers are one debounced save per connected client.
 * A lost update costs one client one restore, and a fresh boot recovers from
 * that.
 */
let tmpCounter = 0;
export async function writeLayout(client: string, text: string): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    console.warn(`[layout] refusing to save non-JSON layout (${err})`);
    return false;
  }
  const existing = await readFileJson();
  // An adoptable file is the pre-split single layout, and this write drops it.
  // It has already been handed to whoever read it. Keeping it would leave a
  // copy for the next upgrade to hand to a different client.
  const base = existing !== null && !adoptable(existing) ? (existing as Record<string, unknown>) : {};
  const next = { ...base, [key(client)]: value };

  await ensureAppHome();
  tmpCounter += 1;
  const tmp = join(APP_HOME, `.${basename(LAYOUT_PATH)}.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, JSON.stringify(next), "utf8");
    await rename(tmp, LAYOUT_PATH);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return true;
}

// The file key for a client id. The id comes from the client and becomes a
// key in a file this module writes, so it is checked rather than trusted.
// Anything that is not a plain id shares the anonymous bucket instead of
// becoming a key of its own.
function key(client: string): string {
  return /^[0-9a-zA-Z-]{1,64}$/.test(client) ? client : ANONYMOUS;
}

async function readFileJson(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(LAYOUT_PATH, "utf8"));
  } catch {
    return null;
  }
}
