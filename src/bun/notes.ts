// The note store: plain Markdown files on disk, and the only thing that owns
// them. Bun already owns the PTY, so it owns the filesystem too; the webview
// never touches a path directly, it asks over RPC.
//
// Notes live flat in ~/.ledge as *.md. A note's identity is its path. That is
// deliberately NOT the docId the rest of the app uses: docId is the identity of a
// *live session* (the editor in the pool, and the note's two shells), and binding
// it to a path would mean renaming a file killed the shell running inside it. One
// note maps to one path and one docId; they are separate keys for separate
// lifetimes.
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { NoteMeta } from "../shared/rpc-schema";
import { headingOf, labelOf, slugOf, titleOf } from "../shared/slug";

// Overridable so a test (or a throwaway run) can point the store at a scratch
// folder instead of the real notes. Nothing in the app sets it.
export const NOTES_ROOT = process.env["LEDGE_NOTES_ROOT"] ?? join(homedir(), ".ledge");

// Deleted notes are moved here rather than unlinked. It is a dot-entry, so
// listNotes skips it and deleted notes simply vanish from the app.
//
// This is NOT the system trash: not the Finder Trash (no Dock icon, no Put Back)
// and not the XDG one. That is the point. The system trash cannot be done
// portably or well from here: macOS records Put Back metadata only through
// NSFileManager's trashItemAtURL, Linux wants the freedesktop layout (a
// .trashinfo record per file, plus per-mount .Trash-$uid dirs), and neither Bun
// nor Electrobun exposes either. A folder inside the notes root needs no native
// code, behaves the same on every platform, and is always on one filesystem, so
// the move is an atomic rename that cannot fail with EXDEV. The UI calls this
// "Delete" and does not claim otherwise.
export const TRASH_DIR = join(NOTES_ROOT, ".trash");

// --- pure helpers (unit-tested in notes.test.ts) ----------------------------

// Allocate a filename not already in `taken`: shipping-notes.md,
// shipping-notes-2.md, ... (or untitled.md for a note with no H1 to name it).
//
// Comparison is case-insensitive, and not only for tidiness: macOS's default APFS
// is case-insensitive, so an existing "Foo.md" and a wanted "foo.md" are ONE file
// there, and a case-sensitive check would hand back a name whose rename silently
// clobbers the other note. Being conservative on Linux (enumerating to foo-2.md
// where foo.md would have been free) is the cheap side of that trade.
export function uniqueName(base: string, taken: Set<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  let name = `${base}.md`;
  for (let n = 2; lower.has(name.toLowerCase()); n += 1) name = `${base}-${n}.md`;
  return name;
}

// Is `p` inside `root`? Every path arriving from the webview is checked against
// this before it is read or written: the view is the least trusted end of the
// RPC, and "../../.ssh/id_rsa" must not resolve to a writable note.
export function isInside(root: string, p: string): boolean {
  const r = resolve(root);
  const t = resolve(p);
  return t === r || t.startsWith(r + sep);
}

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

function assertInRoot(path: string): string {
  if (!isInside(NOTES_ROOT, path)) throw new Error(`path outside the notes root: ${path}`);
  return path;
}

export async function ensureRoot(): Promise<void> {
  await mkdir(NOTES_ROOT, { recursive: true });
}

// Every *.md under the root, newest first. Recursive, skipping dot-entries so a
// `.git`, the trash, or an editor's droppings inside the notes folder stay
// invisible (the root itself is a dotfolder; only its children are filtered).
export async function listNotes(): Promise<NoteMeta[]> {
  await ensureRoot();
  const out: NoteMeta[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const heading = await headingAt(path);
        out.push({ path, title: labelOf(heading, path), mtimeMs: (await stat(path)).mtimeMs });
      }
    }
  };
  await walk(NOTES_ROOT);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Read a note, or null if it is gone (deleted behind our back, say).
export async function readNote(path: string): Promise<string | null> {
  assertInRoot(path);
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// Atomic save: write a temp file in the SAME directory, then rename(2) over the
// target. rename is atomic within a filesystem, so a crash (or a `kill -9`)
// mid-save leaves either the old note or the new one, never a half-written file.
// The temp name is dotted so a concurrent listNotes never shows it.
let tmpCounter = 0;
export async function writeNote(path: string, text: string): Promise<void> {
  assertInRoot(path);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  tmpCounter += 1;
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// Names handed out by createNote but not yet on disk. Two notes can reach their
// first save in the same tick; the readdir that computes the next free name would
// then return the same one twice. Reserving between the readdir and the write
// closes that window (nothing awaits in between, so the pair is atomic here).
const reserved = new Set<string>();

// Allocate a file for a note that does not have one yet and write its first
// content. Called on a note's first edit, not when its tab opens: a tab you open
// and never type in leaves nothing behind. The name comes from the note's H1 if
// it has one by then, so a note you title before your first pause never has to be
// created as untitled.md and renamed a moment later.
export async function createNote(text: string): Promise<NoteMeta> {
  await ensureRoot();
  const taken = new Set(await readdir(NOTES_ROOT));
  for (const name of reserved) taken.add(name);
  const name = uniqueName(baseFor(text), taken);
  reserved.add(name);
  const path = join(NOTES_ROOT, name);
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
  assertInRoot(path);
  const dir = dirname(path);
  const current = basename(path);

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
  // in the name allocation rather than here.
  const target = assertInRoot(join(dir, name));
  await rename(path, target);
  return metaFor(target, text);
}

// Delete a note by moving it aside rather than unlinking it. Same rename(2)
// primitive as a save, so it is atomic and cheap, and it means a misclick costs
// a trip to ~/.ledge/.trash (see TRASH_DIR, which is not the system trash) rather
// than the note. Nothing empties that folder yet; it is a deliberate omission
// until there is a UI to do it from.
export async function deleteNote(path: string): Promise<void> {
  assertInRoot(path);
  if (isInside(TRASH_DIR, path)) return; // already trashed
  await mkdir(TRASH_DIR, { recursive: true });
  const taken = new Set(await readdir(TRASH_DIR));
  const name = uniqueName(titleOf(path), taken);
  try {
    await rename(path, join(TRASH_DIR, name));
  } catch (err) {
    // Already gone (deleted in Finder, say) is the outcome the caller wanted.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
