// The Bun end of session persistence: .layout.json in the app home, holding
// which workspaces exist, their pane trees, and which notes are open where.
// One global file even in the per-workspace world — the workspace LIST itself
// is what it records, so it cannot live inside any one workspace.
//
// KEYED BY CLIENT (remote.md §5). The file is an object of client id to that
// client's arrangement, because one server can be looked at from more than one
// screen: a phone must not inherit a desktop's three-pane split, and coming
// back from the phone must not have cost the desktop its layout. The id
// arrives with the connection rather than with each call (shared/wire.ts
// Hello), so nothing above this module has to carry it.
//
// The ownership line moves by exactly one step and no further. Bun now owns
// the MAP: which client, and the atomic write. The VIEW still owns each
// value's shape and self-heals a corrupt one by discarding it at parse time
// (workspace/persist.ts), so what goes in and out of here is still the view's
// opaque text. Dotted and in the app home, so no listing shows it.
import { basename, join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { APP_HOME, ensureAppHome } from "./workspaces";

export const LAYOUT_PATH = join(APP_HOME, ".layout.json");

// Where a client with no id of its own is filed. One bucket for all of them
// rather than none: a client that does not keep an id (or could not write one)
// should still find its tabs where it left them, and two such clients sharing
// an arrangement is a far smaller surprise than a layout that never restores.
const ANONYMOUS = "_";

// The file as it was before it was keyed by client, and how to tell: the view
// stamps a `version` into its own shape (workspace/persist.ts), and a map of
// client ids has no such key at the top level. An install upgrading across
// this change has exactly one arrangement saved and exactly one client asking
// for it, so the first reader adopts it.
function adoptable(parsed: unknown): boolean {
  return typeof parsed === "object" && parsed !== null && "version" in (parsed as Record<string, unknown>);
}

/**
 * This client's saved layout as raw text, or null when it has none — first
 * launch, a new client, or a file that cannot be read. Every one of those
 * means the same thing to the caller (boot fresh), so none are distinguished
 * and the view's parser handles everything else.
 */
export async function readLayout(client: string): Promise<string | null> {
  const parsed = await readFileJson();
  if (parsed === null) return null;
  if (adoptable(parsed)) return JSON.stringify(parsed);
  const mine = (parsed as Record<string, unknown>)[key(client)];
  return mine === undefined ? null : JSON.stringify(mine);
}

/**
 * Persist this client's layout. Two guards, one on each side of the trust
 * boundary: the text must parse as JSON — an RPC that wrote arbitrary
 * view-supplied bytes to a fixed name would be arbitrary byte storage in the
 * folder people sync — and the write is the same temp-plus-rename as a note
 * save, so a crash mid-write leaves the old layout or the new one, never half.
 * Returns false (warned) for non-JSON.
 *
 * Read-modify-write, because the file holds other clients' arrangements too. A
 * lost update here costs one client one restore, which is why this does not
 * grow a lock: the writers are one debounced save per connected client, and
 * the failure they could race into is the same one a fresh boot recovers from.
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
  // An adoptable file is the pre-split single layout. It has already been
  // handed to whoever read it; keeping it now would leave a copy that the next
  // upgrade would hand to a different client.
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

// The id becomes a key in a file this module writes, so it is not taken on
// trust: anything that is not a plain id shares the anonymous bucket rather
// than becoming a key of its own.
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
