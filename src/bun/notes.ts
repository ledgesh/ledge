// The note store: plain Markdown files on disk, and the only thing that owns
// them. Bun already owns the PTY, so it owns the filesystem too; the webview
// never touches a path directly, it asks over RPC.
//
// Notes live as *.md inside a REGISTERED WORKSPACE ROOT (bun/workspaces.ts) —
// one folder per workspace, never the app home itself. Root-scoped operations
// (list, create, search, trash listing) take the root explicitly; path-taking
// operations derive it, because a note's path determines its root and the
// registry guarantees the answer is unique. A note's identity is its path.
// That is deliberately NOT the docId the rest of the app uses: docId is the
// identity of a *live session* (the editor in the pool, and the note's two
// shells), and binding it to a path would mean renaming a file killed the
// shell running inside it. One note maps to one path and one docId; they are
// separate keys for separate lifetimes.
import { basename, dirname, join, relative, resolve } from "node:path";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { BacklinkHit, NoteMeta, TrashMeta } from "../shared/rpc-schema";
import { headingOf, labelOf, slugOf, titleOf } from "../shared/slug";
import { collectHits, type SearchHit } from "../shared/search";
import { resolveWikiTitle, wikiRefsOf } from "../shared/wikilinks";
import { loadIgnore } from "./ignore";
import { assertRegisteredRoot, isInside, kindOf, rootContaining, uniqueName } from "./workspaces";

// Deleted notes are moved into their own root's .ledge-trash rather than
// unlinked. Per root, not one shared bin: the move must stay a same-filesystem
// rename(2) (atomic, and immune to EXDEV when a workspace lives on another
// volume), and a restored note should land back in the workspace it was
// deleted from. It is a dot-entry, so listNotes skips it and deleted notes
// simply vanish. App-prefixed, not plain ".trash": a workspace can be any
// attached folder, and on APFS's default case-insensitivity ".trash" would
// COLLIDE with macOS's own ~/.Trash if someone attached their home directory —
// Ledge's trash list would surface the system trash's .md files and Empty
// Trash would unlink them. The prefix keeps every Ledge-owned entry
// unmistakably Ledge's.
//
// This is NOT the system trash: not the Finder Trash (no Dock icon, no Put
// Back) and not the XDG one. That is the point. The system trash cannot be
// done portably or well from here: macOS records Put Back metadata only
// through NSFileManager's trashItemAtURL, Linux wants the freedesktop layout
// (a .trashinfo record per file, plus per-mount .Trash-$uid dirs), and neither
// Bun nor Electrobun exposes either. A folder inside the workspace root needs
// no native code and behaves the same on every platform. The UI calls this
// "Delete" and does not claim otherwise.
export function trashDirOf(root: string): string {
  return join(resolve(root), ".ledge-trash");
}

// How long a deleted note stays recoverable. Long enough that "I deleted that
// last week" is still true, short enough that the folder stops being an
// unbounded leak. The browser's Trash section says so out loud: an eviction
// nobody was told about is just delayed data loss.
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Re-exported: it lives in shared/slug.ts because the view needs it too (a tab
// whose note loses its H1 falls back to showing the filename).
export { titleOf };

// The filename a note's text asks for: its first-line H1 as a slug, falling back
// to "untitled" for a note with no usable heading. Bun slugs the heading itself
// rather than accepting a name from the view; slugify's output is safe by
// construction (only [a-z0-9-]), so there is no name to validate and no way for
// the view to ask for a path.
function baseFor(text: string): string {
  return slugOf(text) ?? "untitled";
}

// A note as the view sees it. `title` is the display label: the note's heading if
// it has one, else its filename. The filename is a slug of that same heading, so
// this is usually the pretty form of it ("Shipping Notes" for shipping-notes.md).
async function metaFor(path: string, text: string): Promise<NoteMeta> {
  return { path, title: labelOf(headingOf(text), path), mtimeMs: (await stat(path)).mtimeMs };
}

// The same, for a note whose text we do not already have in hand: read just
// enough of the file to label it.
async function metaAt(path: string): Promise<NoteMeta> {
  return { path, title: labelOf(await headingAt(path), path), mtimeMs: (await stat(path)).mtimeMs };
}

// Enough of a note to read its first line. Notes are small, but a note carrying a
// big pasted blob is not worth reading whole just to label it, and listNotes does
// this once per note on every refresh.
const HEAD_BYTES = 4096;
async function headingAt(path: string): Promise<string | null> {
  try {
    // A first line longer than this would be truncated here, but a heading that
    // long is not a usable label (or filename: slugify caps at 60) anyway.
    return headingOf(await Bun.file(path).slice(0, HEAD_BYTES).text());
  } catch {
    return null; // unreadable: fall back to the filename
  }
}

// --- filesystem ------------------------------------------------------------

// A note path from the view must be a .md file inside a registered root. The
// extension check is load-bearing, not tidiness: even with settings.json now
// outside every root (it lives in the app home), a root can hold config of its
// own, and a noteWrite that accepted any in-root path would be an arbitrary-
// file write. Every function taking a view-supplied note path uses this and
// gets the note's root back — the registry guarantees it is unique.
function assertNote(path: string): string {
  const root = rootContaining(path);
  if (!root) throw new Error(`path outside every workspace root: ${path}`);
  if (!/\.md$/i.test(path)) throw new Error(`not a note path: ${path}`);
  return root;
}

// A directory a write may proceed in. Managed roots self-heal (Bun created
// them; a missing one is recreated), but an EXTERNAL root is never mkdir'd:
// a missing external root is what an unmounted volume looks like, and
// mkdir-ing it would grow a shadow directory on the boot disk that catches
// autosaves — notes silently forking away from the real folder until the
// volume remounts. Refusing keeps the edit pending in the view's autosave
// retry instead (notes/store.ts).
async function rootReady(root: string): Promise<void> {
  if (kindOf(root) === "managed") {
    await mkdir(root, { recursive: true });
    return;
  }
  const ok = await stat(root).then((s) => s.isDirectory()).catch(() => false);
  if (!ok) throw new Error(`workspace root is not on disk (unmounted volume?): ${root}`);
}

// Every *.md under the root, newest first. Recursive, skipping dot-entries so a
// `.git`, the trash, or an editor's droppings inside the folder stay invisible —
// and skipping what bun/ignore.ts says to (well-known vendor/build dirs, plus
// the root's own .ledgeignore), so attaching a project folder does not turn
// every package README under node_modules into a note. Ignored directories are
// pruned whole: their subtrees are never even read.
export async function listNotes(root: string): Promise<NoteMeta[]> {
  const r = assertRegisteredRoot(root);
  await rootReady(r);
  const ignore = await loadIgnore(r);
  const out: NoteMeta[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (ignore.ignores(relative(r, path), entry.isDirectory())) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(await metaAt(path));
    }
  };
  await walk(r);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Full-text search over one workspace's note bodies (shared/search.ts owns the
// matching grammar and the caps). Built on listNotes rather than its own walk,
// so what is searchable and what is listed can never disagree — dot-entries
// and the trash stay invisible here because they are invisible there, and the
// workspace scoping is inherited rather than re-implemented. Reading bodies
// whole is deliberate: the label path's HEAD_BYTES economy is about not
// reading blobs to *name* a note, and searching inside them is exactly the
// job that has to. readNote's null (a note deleted mid-scan) costs that note
// and nothing else.
export async function searchNotes(root: string, query: string): Promise<SearchHit[]> {
  return collectHits(query, await listNotes(root), async (path) => (await readNote(path))?.text ?? null);
}

// Backlink context is one result row, not a paragraph.
const CONTEXT_MAX = 200;
function contextOf(lines: string[], line: number): string {
  const text = (lines[line - 1] ?? "").trim();
  return text.length > CONTEXT_MAX ? `${text.slice(0, CONTEXT_MAX)}…` : text;
}

// Every wikilink in the note's own workspace that points at it — the ONE
// backlink definition, shared by the MCP `backlinks` tool and the app's
// Backlinks panel (rpc noteBacklinks), so agents and the UI can never
// disagree about who links where. The root is derived from the path (the
// per-note-call stance), and the scan is scoped to it because wikilinks are:
// a title in one workspace cannot name a note in another. Resolution runs
// against the SAME newest-first meta list the linking notes' editors would
// use — listNotes' sort IS resolveWikiTitle's tie order, so an ambiguous
// title lands on the note a click in the linking note would open. Reading
// every body is searchNotes' accepted cost; a note deleted mid-scan costs
// that note only.
export async function backlinksTo(path: string): Promise<BacklinkHit[]> {
  const root = assertNote(path);
  const target = resolve(path);
  const metas = await listNotes(root);
  const out: BacklinkHit[] = [];
  for (const meta of metas) {
    if (meta.path === target) continue; // a note is not "linked from" itself
    const file = await readNote(meta.path);
    if (file === null) continue;
    const lines = file.text.split("\n");
    for (const ref of wikiRefsOf(file.text)) {
      if (resolveWikiTitle(ref.title, metas)?.path !== target) continue;
      out.push({ ...meta, line: ref.line, context: contextOf(lines, ref.line), raw: ref.raw });
    }
  }
  return out;
}

// Read a note, or null if it is gone (deleted behind our back, say). The mtime
// comes back too: it is the note's disk version, which the view echoes into
// writeNote's baseMtimeMs so a save can tell its own last state from an
// external edit. Stat BEFORE read, deliberately: if a write lands between the
// two, the text is newer than the mtime we report, so the next comparison
// still sees a difference and re-reads — stale-looking, never stale-passing.
export async function readNote(path: string): Promise<{ text: string; mtimeMs: number } | null> {
  assertNote(path);
  try {
    const mtimeMs = (await stat(path)).mtimeMs;
    return { text: await readFile(path, "utf8"), mtimeMs };
  } catch {
    return null;
  }
}

// What a save reports back: the written file's new disk version, and — when
// the guard below fired — where the overwritten external edit went.
export interface WriteResult {
  mtimeMs: number;
  divergedTo: string | null;
}

// Atomic save: write a temp file in the SAME directory, then rename(2) over the
// target. rename is atomic within a filesystem, so a crash (or a `kill -9`)
// mid-save leaves either the old note or the new one, never a half-written file.
// The temp name is dotted so a concurrent listNotes never shows it.
//
// `baseMtimeMs` is the caller's expectation: the disk version it last read or
// wrote. When the file's actual mtime disagrees AND the bytes genuinely differ,
// someone else — an agent in the note's own terminal, git, vim — wrote here
// since. The buffer still wins the live path (its author is the one typing),
// but the external version is first MOVED into the root's trash via deleteNote,
// never destroyed: the same rename-not-unlink stance as every delete, so a
// concurrent edit costs a trip to the Trash section, not the edit. Identical
// bytes just adopt the disk mtime — no write, no trash noise. null means no
// expectation (a note edited before its first read landed) and writes blind.
//
// The returned mtime is the TEMP file's, statted before the rename (which
// preserves it): stat-after-rename could catch a foreign write that landed in
// between and report a version whose bytes we never saw. The stat-then-rename
// window on the guard itself remains — closing it would need an exchange
// primitive POSIX rename lacks — but the guard is aimed at the seconds-to-
// minutes an agent edit sits unnoticed, not at microsecond interleavings.
let tmpCounter = 0;
export async function writeNote(path: string, text: string, baseMtimeMs: number | null = null): Promise<WriteResult> {
  const root = assertNote(path);
  await rootReady(root);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  let divergedTo: string | null = null;
  if (baseMtimeMs !== null) {
    const disk = await stat(path).catch(() => null); // gone is not a conflict: the write recreates it
    if (disk && disk.mtimeMs !== baseMtimeMs) {
      const current = await readFile(path, "utf8").catch(() => null);
      if (current === text) return { mtimeMs: disk.mtimeMs, divergedTo: null };
      if (current !== null) divergedTo = await deleteNote(path);
    }
  }
  tmpCounter += 1;
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, text, "utf8");
    const mtimeMs = (await stat(tmp)).mtimeMs;
    await rename(tmp, path);
    return { mtimeMs, divergedTo };
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// Names handed out by createNote but not yet on disk. Two notes can reach their
// first save in the same tick; the readdir that computes the next free name would
// then return the same one twice. Reserving between the readdir and the write
// closes that window (nothing awaits in between, so the pair is atomic here).
//
// Keyed by the DIRECTORY the name is allocated in, not one global set: the same
// slug in two workspaces is two different files, and a shared set would
// enumerate one of them to -2 for no reason.
const reservedByDir = new Map<string, Set<string>>();
function reservedIn(dir: string): Set<string> {
  const key = resolve(dir);
  let set = reservedByDir.get(key);
  if (!set) {
    set = new Set();
    reservedByDir.set(key, set);
  }
  return set;
}

// Allocate a file for a note that does not have one yet and write its first
// content. Called on a note's first edit, not when its tab opens: a tab you open
// and never type in leaves nothing behind. The name comes from the note's H1 if
// it has one by then, so a note you title before your first pause never has to be
// created as untitled.md and renamed a moment later.
export async function createNote(root: string, text: string): Promise<NoteMeta> {
  const r = assertRegisteredRoot(root);
  await rootReady(r);
  const reserved = reservedIn(r);
  const taken = new Set(await readdir(r));
  for (const name of reserved) taken.add(name);
  const name = uniqueName(baseFor(text), taken);
  reserved.add(name);
  const path = join(r, name);
  try {
    await writeNote(path, text);
  } finally {
    reserved.delete(name);
  }
  return metaFor(path, text);
}

// Move a note's file to match its heading. Returns the note where it now lives,
// which may be the path it was already at: the caller asks for a title, not a
// filename, and this decides what that costs.
//
// The docId is untouched by design: the note's editor, undo history, and running
// shell all survive, which is the whole reason path and docId are separate keys.
// This is what makes naming-by-heading safe despite PLAN D15's warning.
export async function retitleNote(path: string, text: string): Promise<NoteMeta> {
  assertNote(path);
  const dir = dirname(path);
  const current = basename(path);
  const reserved = reservedIn(dir);

  // The note's own name is not an obstacle to itself. Without this, a note
  // already sitting at shipping-notes-2.md (because another note holds
  // shipping-notes.md) would see its own name taken and crawl to -3, -4, -5 on
  // every heading edit.
  const taken = new Set(await readdir(dir));
  taken.delete(current);
  for (const name of reserved) taken.add(name);

  const name = uniqueName(baseFor(text), taken);
  if (name.toLowerCase() === current.toLowerCase()) {
    // Already correctly named (or the enumeration landed back on its own name).
    return metaFor(path, text);
  }

  // uniqueName already skipped every name in `dir`, so this rename cannot clobber
  // another note: rename(2) would do so silently, which is why the check happens
  // in the name allocation rather than here. The target stays in `dir`, so it is
  // inside the same root by construction; assertNote re-checks anyway.
  const target = join(dir, name);
  assertNote(target);
  await rename(path, target);
  return metaFor(target, text);
}

// Delete a note by moving it aside rather than unlinking it. Same rename(2)
// primitive as a save, so it is atomic and cheap, and it means a misclick costs
// a trip to the Trash section rather than the note. The trash is the note's own
// root's — the delete never crosses a filesystem boundary.
//
// Returns where the note landed, so the caller can offer to undo it, or null if
// there was nothing to delete.
export async function deleteNote(path: string): Promise<string | null> {
  const root = assertNote(path);
  const trashDir = trashDirOf(root);
  if (isInside(trashDir, path)) return null; // already trashed
  await mkdir(trashDir, { recursive: true });
  const taken = new Set(await readdir(trashDir));
  const dest = join(trashDir, uniqueName(titleOf(path), taken));
  try {
    await rename(path, dest);
  } catch (err) {
    // Already gone (deleted in Finder, say) is the outcome the caller wanted.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
  return dest;
}

// --- trash ------------------------------------------------------------------

// Only .md files sitting directly in the root's trash count. Anything else in
// there arrived by some route other than a delete, and is left strictly alone:
// Empty removes exactly what the list showed, and nothing it did not.
async function trashFiles(root: string): Promise<Array<{ path: string; stat: Stats }>> {
  const trashDir = trashDirOf(root);
  let names: string[];
  try {
    names = await readdir(trashDir);
  } catch {
    return []; // no trash folder yet: nothing has ever been deleted here
  }
  const out: Array<{ path: string; stat: Stats }> = [];
  for (const name of names) {
    if (name.startsWith(".") || !/\.md$/i.test(name)) continue;
    const path = join(trashDir, name);
    const s = await stat(path).catch(() => null);
    if (s?.isFile()) out.push({ path, stat: s });
  }
  return out;
}

// One workspace's trashed notes, newest deletion first.
//
// `deletedAt` is the file's ctime: the inode's change time, which rename(2)
// updates and nothing afterwards touches, so for a file sitting in the trash it
// IS the moment it was deleted. mtime cannot answer this (it is the last edit,
// so a note written months ago and deleted today would look ancient and be
// evicted on the spot), and stamping mtime with utimes on the way in would
// destroy the note's real last-edited time to store a fact ctime already has:
// a restored note would come back claiming it was edited the instant you deleted
// it. ctime cannot be set at all, which is precisely what makes it trustworthy
// here. Copying the folder wholesale (restoring a backup) does reset it, and
// those entries then get another 30 days: the failure leans toward keeping notes.
export async function listTrash(root: string): Promise<TrashMeta[]> {
  const files = await trashFiles(assertRegisteredRoot(root));
  const out: TrashMeta[] = [];
  for (const { path, stat: s } of files) {
    out.push({ path, title: labelOf(await headingAt(path), path), deletedAt: s.ctimeMs });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

// A trashed note must be a .md file directly inside its root's trash. Stricter
// than the containment check live notes get, because restore and empty are the
// two calls that can move or unlink a file, and "inside .ledge-trash" would also
// accept the folder itself. Returns the root whose trash holds the note.
function assertTrashed(path: string): string {
  const root = rootContaining(path);
  if (!root || dirname(resolve(path)) !== trashDirOf(root) || !/\.md$/i.test(path)) {
    throw new Error(`not a trashed note: ${path}`);
  }
  return root;
}

// Move a note back out of the trash, into the root it was deleted from. Its
// old name may have been taken by a note created since, so the name is
// allocated fresh rather than assumed free: this is a rename(2) like any
// other, and rename(2) clobbers silently.
//
// It goes back to the root's top level, not to whatever subfolder it may have
// been deleted from: nothing records the original path, and the root is where
// notes are created anyway. Worth revisiting if nested notes ever become a
// real thing.
export async function restoreNote(path: string): Promise<NoteMeta> {
  const root = assertTrashed(path);
  await rootReady(root);
  const reserved = reservedIn(root);
  const taken = new Set(await readdir(root));
  for (const name of reserved) taken.add(name);
  const target = join(root, uniqueName(titleOf(path), taken));
  assertNote(target);
  await rename(path, target);
  return metaAt(target);
}

// Unlink one trashed note, for real and for good. assertTrashed is the whole
// safety story: it is the difference between deleting a note the user pointed
// at in the Trash section and deleting an arbitrary file the view named.
//
// Returns false if it was already gone, which is the outcome the caller wanted
// anyway — a note that is not there is not an error.
export async function deleteTrashed(path: string): Promise<boolean> {
  assertTrashed(path);
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

// Unlink every trashed note in one workspace, for real and for good. This and
// deleteTrashed are the genuinely destructive calls in this file, which is why
// the UI puts a confirmation in front of both and nothing else.
export async function emptyTrash(root: string): Promise<number> {
  return removeAll(await trashFiles(assertRegisteredRoot(root)));
}

// Drop one workspace's trashed notes past the TTL. Called once per available
// root at startup: a delete you have forgotten about is exactly the kind that
// should age out, and doing it on a timer while the app runs would mean a note
// vanishing from the list under the pointer.
export async function purgeTrash(root: string, ttlMs: number = TRASH_TTL_MS): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  const files = await trashFiles(root);
  return removeAll(files.filter((f) => f.stat.ctimeMs < cutoff));
}

// Best-effort: a file that vanished under us (or that we cannot unlink) must not
// abort the rest. Returns how many actually went.
async function removeAll(files: Array<{ path: string }>): Promise<number> {
  let n = 0;
  for (const { path } of files) {
    try {
      assertTrashed(path); // belt: removeAll only ever receives trashFiles output
      await unlink(path);
      n += 1;
    } catch (err) {
      console.error("[notes] could not remove a trashed note", path, err);
    }
  }
  return n;
}
