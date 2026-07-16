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

// Overridable so a test (or a throwaway run) can point the store at a scratch
// folder instead of the real notes. Nothing in the app sets it.
export const NOTES_ROOT = process.env["LEDGE_NOTES_ROOT"] ?? join(homedir(), ".ledge");

// --- pure helpers (unit-tested in notes.test.ts) ----------------------------

// Allocate a filename not already in `taken`: untitled.md, untitled-2.md, ...
// New notes are named at creation and never renamed by their content: the H1 is
// the title, the filename is an identifier. (PLAN D15: renaming files out from
// under open tabs, shells, and watchers is a footgun.)
export function uniqueName(base: string, taken: Set<string>): string {
  let name = `${base}.md`;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}.md`;
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

// The tab label for a note: its filename without the extension.
export function titleOf(path: string): string {
  return basename(path).replace(/\.md$/i, "");
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
// `.git` or an editor's droppings inside the notes folder stay invisible (the
// root itself is a dotfolder; only its children are filtered).
export async function listNotes(): Promise<NoteMeta[]> {
  await ensureRoot();
  const out: NoteMeta[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        out.push({ path, title: titleOf(path), mtimeMs: (await stat(path)).mtimeMs });
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
// and never type in leaves nothing behind.
export async function createNote(text: string): Promise<NoteMeta> {
  await ensureRoot();
  const taken = new Set(await readdir(NOTES_ROOT));
  for (const name of reserved) taken.add(name);
  const name = uniqueName("untitled", taken);
  reserved.add(name);
  const path = join(NOTES_ROOT, name);
  try {
    await writeNote(path, text);
  } finally {
    reserved.delete(name);
  }
  return { path, title: titleOf(path), mtimeMs: (await stat(path)).mtimeMs };
}
