// The workspace-roots registry: which folders on disk are note roots. No other
// module decides that, and every path guard in the note store validates against
// this set.
//
// The registry is a trust artifact, because one the view could write would give
// the view read and write access to any .md anywhere. So .workspaces.json is
// machine-written and Bun-shaped, unlike view-shaped .layout.json, and the view
// never reads or writes its bytes. A root gets in four ways (architecture.md
// §2); the fourth is the docs root that loadWorkspaces registers in memory.
//
// This module also owns APP_HOME (~/.ledge). It holds settings.jsonc,
// .layout.json, and .workspaces.json, and is where managed workspace folders
// are created. Notes live in the registered roots, never directly in APP_HOME.
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { slugify } from "../shared/slug";
import type { TrashedWorkspace, WorkspaceRootInfo } from "../shared/rpc-schema";

// The app's own folder, overridable so a test (or a throwaway run) can point
// the whole app at a scratch folder. Nothing in the app sets the variable. Its
// name predates the per-workspace split, when this was the single notes root,
// and is kept: every test preload, probe recipe, and doc already speaks it.
export const APP_HOME = process.env["LEDGE_NOTES_ROOT"] ?? join(homedir(), ".ledge");

export const WORKSPACES_PATH = join(APP_HOME, ".workspaces.json");

// The built-in documentation's folder (architecture.md §3b). bun/docs.ts syncs
// the bundled pages into it at every launch, and loadWorkspaces below registers
// it in memory, so the read paths (noteList, noteRead, search, wikilinks) serve
// doc pages through the machinery notes already use. It is never written to
// .workspaces.json, and every mutating seam in notes.ts and assets.ts refuses
// it by calling assertWritableRoot below. The name is dotted and
// .ledge-prefixed like every app-owned entry, so it cannot collide with a
// managed workspace slug (slugify emits only [a-z0-9-], never a leading dot).
export const DOCS_ROOT = join(APP_HOME, ".ledge-docs");

// The ignore file a new managed workspace is seeded with, so that `git init`
// in it commits the notes and their images and not the trash. Only
// createManaged writes it: an attached folder's .gitignore is the user's file,
// and the trash carries an ignore file of its own for that case (notes.ts
// ensureTrashDir).
export const GITIGNORE = ".gitignore";

const WORKSPACE_GITIGNORE = `# Ledge workspace. Notes and .ledge-assets/ are committed; these are not.
.ledge-trash/
.*.md.tmp-*
.DS_Store
`;

export async function ensureAppHome(): Promise<void> {
  await mkdir(APP_HOME, { recursive: true });
}

// --- pure helpers (unit-tested in workspaces.test.ts) ------------------------
// These lived in notes.ts when there was one root; they sit here now so the
// dependency arrow points one way (notes/assets/settings/layout -> workspaces)
// instead of cycling.

// True when `p` is inside `root`. Every path arriving from the webview is
// checked against a registered root before it is read or written: the view is
// the least trusted end of the RPC (architecture.md §2), and "../../.ssh/id_rsa"
// must not resolve to a writable note. The trailing-sep check keeps out a
// sibling whose name merely starts with the root ("/notes-2" vs "/notes").
export function isInside(root: string, p: string): boolean {
  const r = resolve(root);
  const t = resolve(p);
  return t === r || t.startsWith(r + sep);
}

// Allocate a filename not already in `taken`: shipping-notes.md,
// shipping-notes-2.md, and so on (with ext "", a workspace folder name).
// Comparison is case-insensitive because macOS's default APFS is: "Foo.md" and
// "foo.md" are one file there, so a case-sensitive check would return a name
// whose rename overwrites the other note. On Linux it only means an extra
// foo-2.md where foo.md was free.
export function uniqueName(base: string, taken: Set<string>, ext = ".md"): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  let name = `${base}${ext}`;
  for (let n = 2; lower.has(name.toLowerCase()); n += 1) name = `${base}-${n}${ext}`;
  return name;
}

// The roots a loosely-spelled workspace name could mean: a root path (~
// expands), or the folder name of a registered root as shorthand. The CLI's
// --workspace argument (cli.ts resolveWorkspaceArg) and the daily.workspace
// setting (daily.ts) share it, so a name reaches the same workspace from the
// shell and from settings.jsonc. Each caller decides what a miss costs: the CLI
// throws its own error texts, the setting warns and falls back. An empty result
// is no match; two or more is an ambiguous folder name.
export function workspaceMatches(
  value: string,
  registered: readonly string[],
  home: string = homedir(),
): string[] {
  const expanded = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  const asPath = resolve(expanded);
  if (registered.includes(asPath)) return [asPath];
  return registered.filter((r) => basename(r) === value);
}

// --- the registry ------------------------------------------------------------

// `kind` is derived from location, not stored: the docs folder is one exact
// path, a direct child of APP_HOME is managed (Bun created it, and mkdir may
// self-heal it), anything else is external (the user pointed at it, and a
// missing volume must not grow a shadow directory on the boot disk: see
// rootReady in notes.ts). Deriving it removes the invalid state "managed but
// elsewhere" instead of validating it. Deriving "docs" also keeps the docs
// folder unattachable: invalidRootReason below exempts only kind "managed" from
// its inside-the-app-home check, and the docs folder is not managed.
export function kindOf(root: string): "managed" | "external" | "docs" {
  const r = resolve(root);
  if (r === resolve(DOCS_ROOT)) return "docs";
  return dirname(r) === resolve(APP_HOME) ? "managed" : "external";
}

// Resolved root -> availability, in registration order. Loaded once at startup
// (server.ts createServer), before any RPC is served. `available` is that
// load-time snapshot: an external volume mounted mid-session becomes available
// at the next launch, not live.
const entries = new Map<string, { available: boolean }>();

export function roots(): string[] {
  return [...entries.keys()];
}

export function availableRoots(): string[] {
  return [...entries].filter(([, e]) => e.available).map(([r]) => r);
}

// The available roots a note can be created in: everything but the read-only
// docs root. Read scans keep using availableRoots, since doc pages are readable
// corpus. The "sole workspace" deixis (mcpTools targetWorkspace) uses this one,
// so it can never resolve to a folder that refuses writes.
export function writableRoots(): string[] {
  return availableRoots().filter((r) => kindOf(r) !== "docs");
}

// Every registered root a passphrase change has to cover: writableRoots
// without the availability filter. The sweep must SEE an unmounted volume
// rather than skip it (locking.md §3): its locked notes keep the old wrap, so
// skipping one and committing anyway strands them under neither passphrase.
// `available` is a load-time snapshot besides, so the sweep's own listNotes is
// the live answer and the refusal is built on that.
export function lockableRoots(): string[] {
  return roots().filter((r) => kindOf(r) !== "docs");
}

export function listWorkspaceRoots(): WorkspaceRootInfo[] {
  return [...entries].map(([root, e]) => ({ root, kind: kindOf(root), available: e.available }));
}

// The registered root containing `path`, or null. Every note-path guard starts
// here. The answer is unique because of the no-nesting rule below, so "the root
// of a path" is well-defined.
export function rootContaining(path: string): string | null {
  const p = resolve(path);
  for (const root of entries.keys()) if (isInside(root, p)) return root;
  return null;
}

// Gate for the `root` params arriving over RPC: exact membership, nothing
// derived. The view only ever passes back roots Bun handed it, so anything else
// is a bug or an attack. Either way it stops here.
export function assertRegisteredRoot(root: string): string {
  const r = resolve(root);
  if (!entries.has(r)) throw new Error(`not a registered workspace root: ${root}`);
  return r;
}

// The read-only gate for the built-in documentation (architecture.md §3b).
// Every mutating seam in the note store calls it, so the app, the MCP tools,
// and the CLI get one refusal however they arrive. The view's hidden verbs and
// read-only editor are presentation over this, not the enforcement. Anything
// new that writes, renames, or moves a note or an asset calls this on its root:
// the write-side sibling of the unlink rule's three-list sentence
// (architecture.md §3).
export function assertWritableRoot(root: string): string {
  if (kindOf(root) === "docs") throw new Error("the built-in documentation is read-only");
  return root;
}

// --- persistence -------------------------------------------------------------

// On-disk shape, version 1: just the root paths. Same atomic temp-plus-rename
// as every other write in APP_HOME.
let tmpCounter = 0;
async function save(): Promise<void> {
  await ensureAppHome();
  // The docs root never persists: loadWorkspaces registers it in memory at
  // every load. A stored line would go stale, and would come back as an
  // ordinary writable root if DOCS_ROOT ever moved.
  const text = JSON.stringify({ version: 1, roots: [...entries.keys()].filter((r) => kindOf(r) !== "docs") });
  tmpCounter += 1;
  const tmp = join(APP_HOME, `.workspaces.json.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, WORKSPACES_PATH);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// The registered root that `p` would nest with, or null when clear. One root
// inside another would give rootContaining two answers, and an ambiguous path
// guard is a hole.
function nestingConflict(p: string): string | null {
  for (const root of entries.keys()) {
    if (isInside(root, p) || isInside(p, root)) return root;
  }
  return null;
}

// Why `p` cannot be a root, or null when it can. A root must not be APP_HOME,
// must not contain APP_HOME, and must not sit inside APP_HOME unless it is a
// direct child (a managed folder). APP_HOME itself can never be a root again:
// settings.jsonc lives there and names the shell executable, and "every .md in
// ~/.ledge" is the reach the per-workspace split removed.
function invalidRootReason(p: string): string | null {
  if (resolve(p) === resolve(APP_HOME)) return "is the app home itself";
  if (isInside(p, APP_HOME)) return "contains the app home";
  if (isInside(APP_HOME, p) && kindOf(p) !== "managed") return "nested inside the app home";
  return null;
}

// Load (or reload) the registry from disk. An unparseable file is renamed
// aside and the run continues with no roots from it, keeping the bytes for
// forensics and touching no note. A malformed entry inside a good file costs
// only itself. A root that is merely missing on disk is kept, marked
// unavailable: that is what an unmounted volume looks like, and dropping it
// would turn a remount into data loss (the layout referencing it would be
// pruned).
export async function loadWorkspaces(): Promise<void> {
  entries.clear();
  // The docs root, first and unconditionally, and in memory only (save()
  // filters it out). Bun owns this folder, so mkdir recreates it here the way
  // it recreates a managed one, and bun/docs.ts re-fills it right after this
  // load. Registering it before the file's roots lets nestingConflict below
  // shield it from a hand-edited line that would nest with it.
  {
    const available = await mkdir(DOCS_ROOT, { recursive: true }).then(() => true).catch(() => false);
    entries.set(resolve(DOCS_ROOT), { available });
  }
  let raw: string | null = null;
  try {
    raw = await readFile(WORKSPACES_PATH, "utf8");
  } catch {
    return; // first launch: nothing registered yet
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.warn(`[workspaces] ${WORKSPACES_PATH} is not valid JSON (${err}); starting empty`);
    const aside = `${WORKSPACES_PATH}.bad-${Date.now()}`;
    await rename(WORKSPACES_PATH, aside).catch(() => {});
    return;
  }
  const list =
    typeof json === "object" && json !== null && !Array.isArray(json) && Array.isArray((json as Record<string, unknown>)["roots"])
      ? ((json as Record<string, unknown>)["roots"] as unknown[])
      : [];
  for (const item of list) {
    // Absoluteness is checked on the raw string: resolve() would silently
    // absolutize a relative entry against whatever cwd the app launched from.
    if (typeof item !== "string" || !isAbsolute(item)) continue;
    const p = resolve(item);
    const reason = invalidRootReason(p) ?? (nestingConflict(p) ? "nested with another root" : null);
    if (reason) {
      console.warn(`[workspaces] dropping registered root ${item}: ${reason}`);
      continue;
    }
    if (entries.has(p)) continue;
    let available = await stat(p).then((s) => s.isDirectory()).catch(() => false);
    if (!available && kindOf(p) === "managed") {
      // Bun created this folder, so Bun may recreate it. External roots get no
      // such mkdir: a missing volume must not grow a shadow directory.
      available = await mkdir(p, { recursive: true }).then(() => true).catch(() => false);
    }
    entries.set(p, { available });
  }
}

// Guarantees the view boots with at least one folder to put a note in. Runs
// after loadWorkspaces at launch. A first launch, or a registry healed to
// empty, gets APP_HOME/scratch. Returns that folder when nothing at all was
// registered before, which is the launch that gets the welcome note
// (server.ts), and null otherwise. A registry whose only roots are on an
// unmounted volume still gets a folder, but not the welcome note.
export async function ensureDefault(): Promise<string | null> {
  // The docs root does not count: it is read-only, so a boot with only docs
  // registered still has nowhere to put a note.
  if (availableRoots().some((r) => kindOf(r) !== "docs")) return null;
  const first = ![...entries.keys()].some((r) => kindOf(r) !== "docs");
  const root = await createManaged("Scratch");
  return first ? root : null;
}

// Creates a managed workspace folder from a display name. Bun slugs the name
// itself, the same trust move as noteCreate: slugify emits only [a-z0-9-], so
// the view has no path to smuggle through. uniqueName allocates the folder name
// against a readdir snapshot of APP_HOME, so the mkdir cannot land on something
// that exists. settings.jsonc, dot-entries, and squatting files all count as
// taken.
export async function createManaged(name: string): Promise<string> {
  await ensureAppHome();
  const base = slugify(name) ?? "workspace";
  const taken = new Set(await readdir(APP_HOME));
  const root = join(APP_HOME, uniqueName(base, taken, ""));
  await mkdir(root, { recursive: true });
  // Best-effort: a workspace the user asked for matters more than its ignore
  // file, so a failed write is logged and the folder is still a workspace.
  await writeFile(join(root, GITIGNORE), WORKSPACE_GITIGNORE, "utf8").catch((err) => {
    console.warn(`[workspaces] could not write ${GITIGNORE} in ${root}`, err);
  });
  entries.set(resolve(root), { available: true });
  await save();
  return resolve(root);
}

// The path a person typed, with a leading `~` meaning this user's home. Only
// that form: `~name/` is a shell's to expand, and a path with no tilde is
// returned as it came.
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

// Registers an existing directory as a workspace root. `path` is the one call
// where the view names a path rather than passing a handle back (server.ts
// workspaceAttach): typed in the Attach Folder dialog, or filled by the Mac's
// picker. So this is where it is checked, and the checks are the same ones a
// picked folder got: an absolute directory, not the app home or anything
// holding it, not nested with another root. Attaching an already-registered
// root is idempotent: the caller focuses the existing workspace instead of
// growing a twin, openNote's open-once move.
export async function attachExternal(path: string): Promise<{ root: string } | { error: string }> {
  const typed = expandHome(path.trim());
  if (!isAbsolute(typed)) return { error: `not an absolute path: ${path}` };
  const p = resolve(typed);
  const isDir = await stat(p).then((s) => s.isDirectory()).catch(() => false);
  if (!isDir) return { error: `not a directory: ${path}` };
  // Checked before the idempotent-attach answer below: the docs root is
  // registered, so returning it here would present it as an ordinary
  // attachable folder.
  if (kindOf(p) === "docs") return { error: "that folder is Ledge's built-in documentation (read-only)" };
  if (entries.has(p)) return { root: p };
  const reason = invalidRootReason(p);
  if (reason) return { error: `cannot attach ${path}: ${reason}` };
  const conflict = nestingConflict(p);
  if (conflict) return { error: `cannot attach ${path}: nested with the workspace folder ${conflict}` };
  entries.set(p, { available: true });
  await save();
  return { root: p };
}

// Removes a root from the registry. This never touches the filesystem: Remove
// from Ledge costs the registry line and no note bytes, the rename-not-unlink
// stance applied to whole folders (architecture.md §3). A detached folder is
// re-attachable with everything still in it, managed ones included, through
// attachExternal's direct-child allowance, and a later attach takes it back
// without a dialog for as long as this process runs.
export async function detachRoot(root: string): Promise<boolean> {
  // The docs root cannot be deregistered: dropping it mid-session would strand
  // open doc tabs outside every path guard. Closing the docs workspace is a
  // view arrangement, and the registry line stays.
  if (kindOf(root) === "docs") return false;
  const r = resolve(root);
  const removed = entries.delete(r);
  if (removed) await save();
  return removed;
}

// --- the workspace trash -----------------------------------------------------

// Deleted managed workspaces (architecture.md §3). Each entry is a directory
// named by its id, holding the workspace folder and ENTRY_META: the name and
// icon the strip showed, and when it was deleted. Attached folders never come
// here; Remove from Ledge (detachRoot) is their only verb.
export const WORKSPACE_TRASH = join(APP_HOME, ".ledge-trash");
const ENTRY_META = "workspace.json";

// Display strings from the view are capped rather than refused: they are
// labels, never names on disk.
const NAME_MAX = 200;
const SYMBOL_MAX = 64;

interface EntryMeta {
  name: string;
  symbol: string;
  folder: string;
  deletedAt: number;
}

// The entry directory an id names, or null. An id is one visible segment
// directly inside WORKSPACE_TRASH: no separator, no dot-leading name, so no
// id can reach the trash itself, its parent, or anything beside an entry. This
// is the guard in front of the recursive delete below.
export function trashEntryDir(id: string): string | null {
  if (id === "" || id.startsWith(".") || /[/\\]/.test(id)) return null;
  const dir = resolve(join(WORKSPACE_TRASH, id));
  return dirname(dir) === resolve(WORKSPACE_TRASH) ? dir : null;
}

// The folder name inside an entry: the one its meta names when that is a
// directory there, else the entry's only visible directory. A hand-edited or
// half-written meta file costs the name, not the workspace.
async function entryFolder(dir: string, meta: Partial<EntryMeta>): Promise<string | null> {
  const named = typeof meta.folder === "string" ? meta.folder : "";
  if (named && !named.startsWith(".") && !/[/\\]/.test(named)) {
    if (await stat(join(dir, named)).then((s) => s.isDirectory()).catch(() => false)) return named;
  }
  const dirs = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."));
  return dirs.length === 1 ? dirs[0]!.name : null;
}

async function readEntryMeta(dir: string): Promise<Partial<EntryMeta>> {
  try {
    const json: unknown = JSON.parse(await readFile(join(dir, ENTRY_META), "utf8"));
    return typeof json === "object" && json !== null ? (json as Partial<EntryMeta>) : {};
  } catch {
    return {};
  }
}

// When an entry was deleted: its meta's stamp, else the entry directory's
// mtime, which the meta write set when the entry was made.
async function entryDeletedAt(dir: string, meta: Partial<EntryMeta>): Promise<number> {
  if (typeof meta.deletedAt === "number" && Number.isFinite(meta.deletedAt)) return meta.deletedAt;
  return stat(dir).then((s) => s.mtimeMs).catch(() => 0);
}

// How many notes a trashed folder holds, for the row and the confirm. Counts
// visible .md files the way listNotes walks, without its ignore rules: the
// number is what a permanent delete removes.
async function countNotes(dir: string): Promise<number> {
  let n = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.isFile() && /\.md$/i.test(e.name)) n += 1;
    }
  };
  await walk(dir);
  return n;
}

// Moves a managed root's folder into the workspace trash and deregisters it.
// One rename(2): managed folders and the trash both sit in APP_HOME, so the
// move never crosses a volume. The root leaves the in-memory registry before
// the rename, so no note write lands in the folder mid-move, and a failed
// rename puts it back in its old place.
export async function trashRoot(
  root: string,
  name: string,
  symbol: string,
): Promise<{ id: string } | { error: string }> {
  const r = resolve(root);
  const kind = kindOf(r);
  if (kind === "docs") return { error: "the built-in documentation cannot be deleted" };
  if (kind === "external") return { error: "an attached folder is removed from Ledge, not deleted" };
  const entry = entries.get(r);
  if (!entry) return { error: `not a registered workspace root: ${root}` };
  if (!entry.available) return { error: `workspace folder is not available: ${root}` };
  await mkdir(WORKSPACE_TRASH, { recursive: true });
  const id = uniqueName(basename(r), new Set(await readdir(WORKSPACE_TRASH)), "");
  const dir = join(WORKSPACE_TRASH, id);
  const meta: EntryMeta = {
    name: name.slice(0, NAME_MAX),
    symbol: symbol.slice(0, SYMBOL_MAX),
    folder: basename(r),
    deletedAt: Date.now(),
  };
  // Undoes the entry by name, never recursively: on any failure path the
  // entry holds at most the meta file. `made` keeps it off a directory some
  // other call created.
  let made = false;
  const dropEntry = async () => {
    if (!made) return;
    await unlink(join(dir, ENTRY_META)).catch(() => {});
    await rmdir(dir).catch(() => {});
  };
  const order = [...entries];
  try {
    await mkdir(dir);
    made = true;
    await writeFile(join(dir, ENTRY_META), JSON.stringify(meta), "utf8");
    entries.delete(r);
    await rename(r, join(dir, basename(r)));
  } catch (err) {
    entries.clear();
    for (const [k, v] of order) entries.set(k, v);
    await dropEntry();
    return { error: `delete failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  await save();
  return { id };
}

// Every deleted workspace, newest first.
export async function listTrashedWorkspaces(): Promise<TrashedWorkspace[]> {
  const out: TrashedWorkspace[] = [];
  for (const e of await readdir(WORKSPACE_TRASH, { withFileTypes: true }).catch(() => [])) {
    const dir = e.isDirectory() ? trashEntryDir(e.name) : null;
    if (!dir) continue;
    const meta = await readEntryMeta(dir);
    const folder = await entryFolder(dir, meta);
    if (!folder) continue;
    out.push({
      id: e.name,
      name: typeof meta.name === "string" && meta.name.trim() ? meta.name : folder,
      symbol: typeof meta.symbol === "string" ? meta.symbol : "",
      deletedAt: await entryDeletedAt(dir, meta),
      notes: await countNotes(join(dir, folder)),
    });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

// Moves a deleted workspace's folder back into APP_HOME and registers it. The
// folder keeps its name unless something took it meanwhile, in which case
// uniqueName enumerates. The entry directory then goes, which unlinks only the
// meta file this module wrote.
export async function restoreTrashedWorkspace(
  id: string,
): Promise<{ root: string; name: string; symbol: string } | { error: string }> {
  const dir = trashEntryDir(id);
  if (!dir) return { error: `not a deleted workspace: ${id}` };
  const meta = await readEntryMeta(dir);
  const folder = await entryFolder(dir, meta);
  if (!folder) return { error: `not a deleted workspace: ${id}` };
  await ensureAppHome();
  const next = resolve(join(APP_HOME, uniqueName(folder, new Set(await readdir(APP_HOME)), "")));
  const conflict = nestingConflict(next);
  if (conflict) return { error: `cannot restore ${folder}: nested with the workspace folder ${conflict}` };
  try {
    await rename(join(dir, folder), next);
  } catch (err) {
    return { error: `restore failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  entries.set(next, { available: true });
  await save();
  await unlink(join(dir, ENTRY_META)).catch(() => {});
  await rmdir(dir).catch(() => {});
  return {
    root: next,
    name: typeof meta.name === "string" && meta.name.trim() ? meta.name : folder,
    symbol: typeof meta.symbol === "string" ? meta.symbol : "",
  };
}

// Deletes one trashed workspace for good: its folder and everything in it. The
// view confirms first (interactions.md §4). Guarded by trashEntryDir, so only
// an entry directly inside the workspace trash can go. False when it was
// already gone.
export async function deleteTrashedWorkspace(id: string): Promise<boolean> {
  const dir = trashEntryDir(id);
  if (!dir) throw new Error(`not a deleted workspace: ${id}`);
  if (!(await stat(dir).then((s) => s.isDirectory()).catch(() => false))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

// Drops deleted workspaces past the TTL, once per launch (server.ts), on the
// same clock and setting as purgeTrash for notes. Returns how many went.
export async function purgeTrashedWorkspaces(ttlMs: number): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  let n = 0;
  for (const e of await readdir(WORKSPACE_TRASH, { withFileTypes: true }).catch(() => [])) {
    const dir = e.isDirectory() ? trashEntryDir(e.name) : null;
    if (!dir) continue;
    if ((await entryDeletedAt(dir, await readEntryMeta(dir))) >= cutoff) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      n += 1;
    } catch (err) {
      console.error("[workspaces] could not purge a deleted workspace", dir, err);
    }
  }
  return n;
}

