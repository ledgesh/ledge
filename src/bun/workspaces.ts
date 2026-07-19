// The workspace-roots registry: which folders on disk are note roots, and the
// only module that may say so. Every path guard in the store validates against
// this set, which makes the registry a TRUST ARTIFACT: unlike .layout.json
// (machine-written, view-shaped), .workspaces.json is machine-written AND
// Bun-shaped — the view never reads or writes its bytes, and the only ways a
// root gets in are Bun's own default, a name Bun slugged itself, or a folder
// the user picked in the native dialog. A registry the view could write would
// hand the view "any .md anywhere" read/write; this one it cannot even see.
//
// This module also owns APP_HOME (formerly the notes root): ~/.ledge is where
// the app's own files live — settings.jsonc, .layout.json, .workspaces.json —
// and where managed workspace folders are created. Notes never live directly
// in APP_HOME anymore; they live in the registered roots.
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { slugify } from "../shared/slug";
import type { WorkspaceRootInfo } from "../shared/rpc-schema";

// Overridable so a test (or a throwaway run) can point the whole app at a
// scratch folder. Nothing in the app sets it. The env name predates the
// per-workspace split (this was once the single notes root) and is kept:
// every test preload, probe recipe, and doc already speaks it.
export const APP_HOME = process.env["LEDGE_NOTES_ROOT"] ?? join(homedir(), ".ledge");

export const WORKSPACES_PATH = join(APP_HOME, ".workspaces.json");

// The built-in documentation's folder: Bun syncs the bundled doc pages into it
// at every launch (bun/docs.ts) and registers it IN MEMORY below, so the read
// paths — noteList, noteRead, search, wikilinks — serve doc pages through the
// exact machinery notes already ride. It is never written to .workspaces.json
// (it is a fact about the installed app, not a user choice, and a registry
// line would go stale across versions), and every mutating seam refuses it
// (notes.ts assertWritableRoot): registered-and-readable, unwritable-and-
// undetachable. Dotted and .ledge-prefixed like every app-owned entry, so it
// can never collide with a managed workspace slug (slugs cannot start with a
// dot).
export const DOCS_ROOT = join(APP_HOME, ".ledge-docs");

export async function ensureAppHome(): Promise<void> {
  await mkdir(APP_HOME, { recursive: true });
}

// --- pure helpers (unit-tested in workspaces.test.ts) ------------------------
// These lived in notes.ts when there was one root; they sit here now so the
// dependency arrow points one way (notes/assets/settings/layout -> workspaces)
// instead of cycling.

// Is `p` inside `root`? Every path arriving from the webview is checked against
// a registered root before it is read or written: the view is the least trusted
// end of the RPC, and "../../.ssh/id_rsa" must not resolve to a writable note.
// The trailing-sep check is what keeps a sibling whose name merely starts with
// the root ("/notes-2" vs "/notes") outside.
export function isInside(root: string, p: string): boolean {
  const r = resolve(root);
  const t = resolve(p);
  return t === r || t.startsWith(r + sep);
}

// Allocate a filename not already in `taken`: shipping-notes.md,
// shipping-notes-2.md, ... (or, with ext "", a workspace folder name).
//
// Comparison is case-insensitive, and not only for tidiness: macOS's default APFS
// is case-insensitive, so an existing "Foo.md" and a wanted "foo.md" are ONE file
// there, and a case-sensitive check would hand back a name whose rename silently
// clobbers the other note. Being conservative on Linux (enumerating to foo-2.md
// where foo.md would have been free) is the cheap side of that trade.
export function uniqueName(base: string, taken: Set<string>, ext = ".md"): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  let name = `${base}${ext}`;
  for (let n = 2; lower.has(name.toLowerCase()); n += 1) name = `${base}-${n}${ext}`;
  return name;
}

// The roots a loosely-spelled workspace could mean: a root path (~ expands),
// or — as shorthand — the folder name of a registered root. Shared by the
// CLI's --workspace argument (cli.ts resolveWorkspaceArg) and the
// daily.workspace setting (daily.ts): what a name MEANS must have one
// definition — a name that reaches workspace X at the shell cannot reach Y
// from settings.jsonc — while what a miss costs stays with each surface (the
// CLI throws its own error texts, the setting degrades to deixis). Empty =
// no match; two or more = an ambiguous basename, for the caller to refuse
// or degrade as suits it.
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

// `kind` is a fact about location, not a stored field: the docs folder is one
// exact path, a direct child of APP_HOME is managed (Bun created it, mkdir may
// self-heal it), anything else is external (the user pointed at it, and a
// missing volume must NOT grow a shadow directory on the boot disk — see
// rootReady in notes.ts). Deriving it removes the invalid state "managed but
// elsewhere" instead of validating it. Deriving "docs" here also closes the
// attach loophole for free: invalidRootReason's inside-the-app-home check
// exempts only kind "managed", so the docs folder — dotted, in the app home,
// not managed — can never be attached as an ordinary (writable) workspace.
export function kindOf(root: string): "managed" | "external" | "docs" {
  const r = resolve(root);
  if (r === resolve(DOCS_ROOT)) return "docs";
  return dirname(r) === resolve(APP_HOME) ? "managed" : "external";
}

// Resolved root -> availability, in registration order. Loaded once at launch
// (index.ts), before any RPC is served; `available` is that load-time snapshot
// (an external volume mounted mid-session heals at the next boot, not live).
const entries = new Map<string, { available: boolean }>();

export function roots(): string[] {
  return [...entries.keys()];
}

export function availableRoots(): string[] {
  return [...entries].filter(([, e]) => e.available).map(([r]) => r);
}

// The available roots something may CREATE into: everything but the read-only
// docs root. Read scans keep using availableRoots — doc pages are readable
// corpus — but "the sole workspace" deixis (mcpTools targetWorkspace) must
// never resolve to a folder that refuses writes.
export function writableRoots(): string[] {
  return availableRoots().filter((r) => kindOf(r) !== "docs");
}

export function listWorkspaceRoots(): WorkspaceRootInfo[] {
  return [...entries].map(([root, e]) => ({ root, kind: kindOf(root), available: e.available }));
}

// The registered root containing `path`, or null. This is the heart of every
// note-path guard: uniqueness of the answer is guaranteed by the no-nesting
// rule below, so "the root of a path" is well-defined.
export function rootContaining(path: string): string | null {
  const p = resolve(path);
  for (const root of entries.keys()) if (isInside(root, p)) return root;
  return null;
}

// Gate for the `root` params arriving over RPC: exact membership, nothing
// derived. The view only ever passes back roots Bun handed it; anything else
// is a bug or worse, and either way it stops here.
export function assertRegisteredRoot(root: string): string {
  const r = resolve(root);
  if (!entries.has(r)) throw new Error(`not a registered workspace root: ${root}`);
  return r;
}

// The read-only gate for the built-in documentation (DOCS_ROOT above):
// registered so every READ path serves doc pages through the ordinary
// machinery, refused by every path that would change a byte. One guard,
// enforced Bun-side, so the app, the MCP tools, and the CLI — which all
// funnel through the note store — get one answer however they arrive; the
// view's hidden verbs and read-only editor are presentation over this, never
// the enforcement. **Anything new that writes, renames, or moves a note (or
// an asset) calls this on its root** — the write-side sibling of the unlink
// rule's three-list sentence (architecture.md §3).
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
  // The docs root never persists: it is registered in memory at every load,
  // and a stored line would only rot (or resurrect writable after the guard
  // that knows it is docs moved).
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

// Would registering `p` break the no-nesting rule against the kept set? One
// root inside another would make rootContaining ambiguous, and ambiguity in a
// path guard is a hole. Returns the offending root, or null when clear.
// `excluding` is for moveRoot: the root being relocated must not veto its own
// destination.
function nestingConflict(p: string, excluding?: string): string | null {
  for (const root of entries.keys()) {
    if (root === excluding) continue;
    if (isInside(root, p) || isInside(p, root)) return root;
  }
  return null;
}

// A candidate root must be an absolute path that neither is, contains, nor —
// unless it is a direct child (a managed folder) — lives inside APP_HOME.
// APP_HOME itself can never be a root again: settings.jsonc lives there and
// names the shell executable, and "every .md in ~/.ledge" was exactly the
// blast radius the per-workspace split removes.
function invalidRootReason(p: string): string | null {
  if (resolve(p) === resolve(APP_HOME)) return "is the app home itself";
  if (isInside(p, APP_HOME)) return "contains the app home";
  if (isInside(APP_HOME, p) && kindOf(p) !== "managed") return "nested inside the app home";
  return null;
}

// Load (or reload) the registry from disk. Machine-written state self-heals:
// an unparseable file is renamed aside — bytes preserved for forensics, no
// note touched — and the run continues empty; each malformed entry costs
// exactly itself. A root that is merely MISSING on disk is kept, unavailable:
// it is what an unmounted volume looks like, and dropping it would turn a
// remount into data loss (the layout referencing it would be pruned).
export async function loadWorkspaces(): Promise<void> {
  entries.clear();
  // The docs root, first and unconditionally: in memory only (save() filters
  // it), self-healed like a managed folder — it is Bun's own artifact, and
  // bun/docs.ts re-fills it right after load. Registered before the file's
  // roots so nestingConflict below also shields it from any hand-edited line
  // that would nest with it.
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
    // Absoluteness is checked on the RAW string: resolve() would silently
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
      // Bun created this folder; Bun may recreate it. External roots get no
      // such mkdir — a missing volume must not grow a shadow directory.
      available = await mkdir(p, { recursive: true }).then(() => true).catch(() => false);
    }
    entries.set(p, { available });
  }
}

// Guarantee the view boots with at least one folder to put a note in. Runs
// after loadWorkspaces at launch; a first launch (or a registry healed to
// empty) gets APP_HOME/scratch.
export async function ensureDefault(): Promise<void> {
  // The docs root does not count: it is read-only, so a boot with only docs
  // registered still has nowhere to put a note.
  if (availableRoots().some((r) => kindOf(r) !== "docs")) return;
  await createManaged("Scratch");
}

// Create a managed workspace folder from a display name. Bun slugs the name
// itself (same trust move as noteCreate: slugify emits only [a-z0-9-], so
// there is no path for the view to smuggle through) and allocates against a
// readdir snapshot — settings.jsonc, dot-entries, and squatting files all count
// as taken, so the mkdir cannot land on something that exists.
export async function createManaged(name: string): Promise<string> {
  await ensureAppHome();
  const base = slugify(name) ?? "workspace";
  const taken = new Set(await readdir(APP_HOME));
  const root = join(APP_HOME, uniqueName(base, taken, ""));
  await mkdir(root, { recursive: true });
  entries.set(resolve(root), { available: true });
  await save();
  return resolve(root);
}

// Register an existing directory as a workspace root. `path` comes from the
// native folder dialog (index.ts), never from the view — that provenance is
// the whole reason external roots are compatible with the trust boundary.
// Idempotent for an already-registered root: the caller focuses the existing
// workspace instead of growing a twin (openNote's open-once move).
export async function attachExternal(path: string): Promise<{ root: string } | { error: string }> {
  if (!isAbsolute(path)) return { error: `not an absolute path: ${path}` };
  const p = resolve(path);
  const isDir = await stat(p).then((s) => s.isDirectory()).catch(() => false);
  if (!isDir) return { error: `not a directory: ${path}` };
  // Before the idempotent-attach answer: the docs root IS registered, but
  // handing it back here would dress it up as an ordinary attachable folder.
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

// Remove a root from the registry. NEVER touches the filesystem: closing a
// workspace costs the registry line, not one byte of notes (the rename-not-
// unlink stance, applied to whole folders). A detached folder — managed ones
// included, via attachExternal's direct-child allowance — is re-attachable
// with everything still in it.
export async function detachRoot(root: string): Promise<boolean> {
  // The docs root is not the user's to deregister: dropping it mid-session
  // would strand open doc tabs outside every path guard. Closing the docs
  // WORKSPACE is a view arrangement; the registry line stays.
  if (kindOf(root) === "docs") return false;
  const removed = entries.delete(resolve(root));
  if (removed) await save();
  return removed;
}

// Relocate a registered root's folder into `destParent` and update its
// registry line to match — the "put my workspace where iCloud can see it"
// move, which a managed root under the hidden ~/.ledge otherwise has no path
// to. `destParent` comes from the native folder dialog (index.ts), the same
// provenance rule as attachExternal: the view names no path.
//
// rename(2) only, deliberately: a cross-volume move would be copy-then-unlink
// of every note at once — the exact operation the rename-not-unlink stance
// exists to avoid — so EXDEV is refused with the Finder-then-attach recipe
// instead of quietly becoming a copier. The folder keeps its name (allocated
// clobber-safe via uniqueName, the standing rename rule), everything inside —
// notes, .ledge-trash, .ledge-assets — travels with it, and `kind` needs no
// bookkeeping: it is derived from location, so moving into the app home makes
// a root managed and moving out makes it external, by construction.
export async function moveRoot(root: string, destParent: string): Promise<{ root: string } | { error: string }> {
  const r = resolve(root);
  if (kindOf(r) === "docs") return { error: "the documentation folder is Bun's own and cannot be moved" };
  const entry = entries.get(r);
  if (!entry) return { error: `not a registered workspace root: ${root}` };
  // An unavailable root is an unmounted volume; there is no folder here to move.
  if (!entry.available) return { error: `workspace folder is not available: ${root}` };
  if (!isAbsolute(destParent)) return { error: `not an absolute path: ${destParent}` };
  const parent = resolve(destParent);
  const isDir = await stat(parent).then((s) => s.isDirectory()).catch(() => false);
  if (!isDir) return { error: `not a directory: ${destParent}` };
  // Its own parent: already there. A no-op, not a rename to a "-2" twin —
  // uniqueName below would count the folder itself as taken.
  if (parent === dirname(r)) return { root: r };
  if (isInside(r, parent)) return { error: "cannot move a workspace into itself" };
  const taken = new Set(await readdir(parent));
  const next = resolve(join(parent, uniqueName(basename(r), taken, "")));
  const reason = invalidRootReason(next);
  if (reason) return { error: `cannot move to ${destParent}: ${reason}` };
  const conflict = nestingConflict(next, r);
  if (conflict) return { error: `cannot move to ${destParent}: nested with the workspace folder ${conflict}` };
  try {
    await rename(r, next);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV")
      return { error: "the destination is on a different volume; move the folder in Finder, then Attach Folder as Workspace" };
    return { error: `move failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Replace the line in place: listWorkspaceRoots promises registration order,
  // and a move is a relocation, not a departure and a new arrival.
  const kept = [...entries].map(([k, v]) => [k === r ? next : k, v] as const);
  entries.clear();
  for (const [k, v] of kept) entries.set(k, v);
  await save();
  return { root: next };
}
