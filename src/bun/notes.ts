// The note store: plain Markdown files on disk, and the only thing that owns
// them. Bun already owns the PTY, so it owns the filesystem too. The webview
// never touches a path directly, it asks over RPC.
//
// Notes live as *.md inside a registered workspace root (bun/workspaces.ts),
// one folder per workspace, never the app home itself. Root-scoped operations
// (list, create, search, trash listing) take the root explicitly. Path-taking
// operations derive it: a note's path determines its root, and the registry
// guarantees the answer is unique.
//
// A note's identity here is its path, which is not the docId the rest of the
// app uses. The two are separate keys with separate lifetimes
// (architecture.md §4).
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { ASSETS_DIRNAME, type BacklinkHit, type NoteMeta, type TagHit, type TrashMeta } from "../shared/rpc-schema";
import { headingOf, labelOf, slugOf, titleOf } from "../shared/slug";
import { parseFrontmatter, setFavoriteLine } from "../shared/frontmatter";
import { collectHits, type SearchHit } from "../shared/search";
import { resolveWikiTitle, wikiRefsOf } from "../shared/wikilinks";
import { normalizeTag, tagDirectoryOf, tagRefsOf, type TagInfo } from "../shared/tags";
import { loadIgnore } from "./ignore";
import { assertRegisteredRoot, assertWritableRoot, GITIGNORE, isInside, kindOf, rootContaining, uniqueName } from "./workspaces";
import {
  beginPassphraseChange,
  commitPassphraseChange,
  isSealedAsset,
  mintLockedHeader,
  openAssetBytes,
  openBody,
  rewrapAssetBytes,
  rewrapHeader,
  sealAssetBytes,
  sealBody,
  splitHead,
  stampLockedLine,
  stripLockedLine,
  touchVault,
  vaultState,
} from "./vault";
import { assetPathOf, assetRefFor, imageMimeOf, rawAssetBytes, replaceAssetBytes } from "./assets";
import { folderLeafProblem, folderNameProblem, folderScopeOf, notesUnder } from "../shared/folders";

// Where a deleted note goes: a `.ledge-trash` directory in its own workspace
// root. The note is moved there by rename(2), not unlinked. architecture.md
// §3 owns why the trash is per root (no EXDEV, and a restore lands where the
// note left), why it is a dot-entry (listNotes skips it), and why the name is
// `.ledge-`prefixed (a plain ".trash" would collide with macOS's ~/.Trash on
// APFS).
//
// This is not the system trash: no Finder Put Back, no XDG bin. macOS records
// Put Back metadata only through NSFileManager's trashItemAtURL, and Linux
// wants the freedesktop layout (a .trashinfo record per file, plus per-mount
// .Trash-$uid directories); neither Bun nor Electrobun exposes either. A
// folder inside the workspace root needs no native code and works the same on
// every platform. The UI calls this "Delete".
export function trashDirOf(root: string): string {
  return join(resolve(root), ".ledge-trash");
}

// The default window a deleted note stays recoverable for. Long enough that a
// note deleted last week can still be restored, short enough that the folder
// does not grow without bound. `settings.trash.ttlDays` is what purgeTrash is
// actually called with (server.ts), and the browser's Trash section says
// "30 days".
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Re-exported: it lives in shared/slug.ts because the view needs it too (a tab
// whose note loses its H1 falls back to showing the filename).
export { titleOf };

// The filename a note's text asks for: its first-line H1 as a slug, or
// "untitled" when the note has no usable heading. Bun slugs the heading itself
// rather than taking a name from the view. slugify emits only [a-z0-9-], so
// there is no name to validate and no way for the view to ask for a path
// (architecture.md §2).
function baseFor(text: string): string {
  return slugOf(text) ?? "untitled";
}

// A note as the view sees it. `title` is the display label: the note's heading
// ("Shipping Notes"), else its filename, a slug of that same heading
// (shipping-notes.md). `template`, `favorite` and `locked` come from the
// frontmatter in the text already in hand, so none of them costs an extra
// read: the ⌥⌘N template picker and the browser's Favorites section both build
// themselves out of the listing. Each is present only when the note is marked,
// and `template` carries `true` or the `daily` role.
async function metaFor(path: string, text: string): Promise<NoteMeta> {
  const p = parseFrontmatter(text).params;
  const root = rootContaining(path);
  const folder = root ? folderOf(root, path) : "";
  return {
    path,
    title: labelOf(headingOf(text), path),
    mtimeMs: (await stat(path)).mtimeMs,
    ...(folder === "" ? {} : { folder }),
    ...(p.template ? { template: p.template } : {}),
    ...(p.favorite ? { favorite: true as const } : {}),
    ...(p.locked !== null ? { locked: true as const } : {}),
  };
}

// The same, for a note whose text is not already in hand: read just enough of
// the file to label and flag it. The locked flag rides the same head read the
// title does, because a locked note's plaintext head is sized to fit it
// (locking.md §2). The sidebar glyph and the body scans' skip both come from
// the listing they already had.
async function metaAt(path: string, root?: string): Promise<NoteMeta> {
  const head = await headAt(path);
  const p = head === null ? null : parseFrontmatter(head).params;
  // The folder rides the meta so every surface that lists notes flatly
  // (quick-open, full-text search, backlinks, the agents' listings) can tell
  // two same-titled notes apart. Derived, never stored: listNotes passes the
  // `root` it already has, and anything else looks it up. Omitted at the top
  // level, where most notes live.
  const r = root ?? rootContaining(path);
  const folder = r ? folderOf(r, path) : "";
  return {
    path,
    title: labelOf(head === null ? null : headingOf(head), path),
    mtimeMs: (await stat(path)).mtimeMs,
    ...(folder === "" ? {} : { folder }),
    ...(p?.template ? { template: p.template } : {}),
    ...(p?.favorite ? { favorite: true as const } : {}),
    ...(p !== null && p.locked !== null ? { locked: true as const } : {}),
  };
}

// Enough of a note to read its first line and its frontmatter block. Notes are
// small, but a note carrying a big pasted blob is not worth reading whole just
// to label it, and listNotes does this once per note on every refresh.
const HEAD_BYTES = 4096;
async function headAt(path: string): Promise<string | null> {
  try {
    // A first line or frontmatter block longer than this is truncated here.
    // slugify caps a heading at 60 characters, so an over-long one is not a
    // usable label anyway, and a frontmatter block past 4KB is the same edge
    // the view accepts (commands/glue.ts noteHead slices the same 4096, in
    // document positions rather than bytes).
    return await Bun.file(path).slice(0, HEAD_BYTES).text();
  } catch {
    return null; // unreadable: fall back to the filename
  }
}

// --- filesystem ------------------------------------------------------------

// A note path from the view must be a .md file inside a registered root. The
// extension check is a guard, not tidiness: settings.jsonc lives in the app
// home, but a root can still hold config files of its own, and a noteWrite
// accepting any in-root path would be an arbitrary-file write. Every function
// taking a view-supplied note path calls this for the root it returns, which
// the registry guarantees is unique.
function assertNote(path: string): string {
  const root = rootContaining(path);
  if (!root) throw new Error(`path outside every workspace root: ${path}`);
  if (!/\.md$/i.test(path)) throw new Error(`not a note path: ${path}`);
  return root;
}

// The path segments of `p` below `dir`, or null when `p` is not visibly inside
// it: outside, the directory itself, or carrying a dot-segment anywhere below
// `dir`. Dot-entries are the invisible ones: Ledge's own .ledge-trash and
// .ledge-assets, and a project's .git. The rule keeps guards and listings
// agreeing: what listNotes and trashFiles hide, no path-taking call accepts.
function visibleSegmentsUnder(dir: string, p: string): string[] | null {
  const d = resolve(dir);
  const t = resolve(p);
  if (!isInside(d, t) || t === d) return null;
  const parts = t.slice(d.length + 1).split(sep);
  return parts.some((part) => part === "" || part.startsWith(".")) ? null : parts;
}

// A note's folder: where inside its workspace it sits, as a root-relative path
// with forward slashes ("projects/api"), or "" at the top level. This is
// placement, not identity. A note is addressed by title (shared/wikilinks.ts)
// and keyed by docId while it is open (architecture.md §4). Derived from the
// path rather than stored, so it cannot go stale.
export function folderOf(root: string, path: string): string {
  const rel = relative(resolve(root), dirname(resolve(path)));
  return rel === "" ? "" : rel.split(sep).join("/");
}

/**
 * Resolve a caller-supplied folder against its root, or throw. Empty or absent
 * means the root itself, where a note lands when nobody says otherwise.
 *
 * A folder is the only name a caller chooses, so it is the only name validated
 * (architecture.md §3 has the rules, and why filenames need none). Shape is
 * `folderNameProblem` in shared/folders.ts, and this gate quotes its answer in
 * the error. The settings validator asks it the same question about
 * `daily.folder`, with no root in reach. Containment needs a root, so it stays
 * here.
 */
export function folderPathOf(root: string, folder: string | null | undefined): string {
  const r = assertRegisteredRoot(root);
  if (folder === null || folder === undefined) return r;
  const problem = folderNameProblem(folder);
  if (problem !== null) throw new Error(`not a folder: ${folder} (${problem})`);
  const rel = folderScopeOf(folder);
  if (rel === "") return r;
  const path = resolve(r, rel);
  if (visibleSegmentsUnder(r, path) === null) throw new Error(`folder outside the workspace root: ${folder}`);
  return path;
}

/**
 * The directory a note may be written into: folderPathOf's guard, plus the two
 * checks that need the disk, plus the mkdir.
 *
 * The ignore check is about visibility, not safety (bun/ignore.ts). A note
 * written where listNotes will never show it is a silent disappearance, and a
 * caller asking for `node_modules` almost certainly did not mean it. The
 * refusal names the ignored segment, which the user can override with a `!`
 * line in `.ledgeignore`.
 */
export async function ensureFolder(root: string, folder: string | null | undefined): Promise<string> {
  const r = assertWritableRoot(assertRegisteredRoot(root));
  await rootReady(r);
  const dir = folderPathOf(r, folder);
  if (dir !== r) {
    // Every ancestor, not just the leaf. listNotes prunes an ignored directory
    // whole and never visits its children, so `node_modules/mine` is invisible
    // because of its parent and a leaf-only check would wave it through.
    const segments = relative(r, dir).split(sep);
    const ignore = await loadIgnore(r);
    for (let i = 0; i < segments.length; i += 1) {
      const rel = segments.slice(0, i + 1).join("/");
      if (ignore.ignores(rel, true)) {
        throw new Error(`"${rel}" is ignored in this workspace, so a note there would never appear in the list (see .ledgeignore)`);
      }
    }
    await mkdir(dir, { recursive: true });
  }
  return dir;
}


// A directory a write may proceed in. A managed root self-heals: Bun created
// it, so a missing one is recreated. An external root is never mkdir'd, since
// a missing one is what an unmounted volume looks like. Creating it would make
// a shadow directory on the boot disk that catches autosaves until the volume
// remounts. Throwing leaves the edit pending in the view's autosave retry
// instead (notes/store.ts).
async function rootReady(root: string): Promise<void> {
  if (kindOf(root) === "managed") {
    await mkdir(root, { recursive: true });
    return;
  }
  const ok = await stat(root).then((s) => s.isDirectory()).catch(() => false);
  if (!ok) throw new Error(`workspace root is not on disk (unmounted volume?): ${root}`);
}

// Every *.md under the root, newest first. The recursive walk skips
// dot-entries (hiding `.git`, the trash and an editor's droppings) and
// whatever bun/ignore.ts names (well-known vendor and build directories, plus
// the root's own .ledgeignore), pruning an ignored directory whole rather than
// reading its subtree. An attached project folder contributes its notes, not
// every package README under node_modules.
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
      else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(await metaAt(path, r));
    }
  };
  await walk(r);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Full-text search over one workspace's note bodies. shared/search.ts owns the
// matching grammar and the caps. Built on listNotes rather than its own walk,
// so what is searchable and what is listed cannot disagree: dot-entries and the
// trash are invisible here because they are invisible there, and the workspace
// scoping is inherited rather than re-implemented. Bodies are read whole here.
// HEAD_BYTES on the label path is about not reading a blob to name a note.
// Searching inside a body is the job that has to read it. readNote's null (a
// note deleted mid-scan) costs that note and nothing else.
//
// Locked notes are skipped whether or not the vault is unlocked (locking.md
// §4). The scans feed overlays and agents alike, and an answer that changed
// with vault state would leak by inconsistency. `lockedSkipped` rides back so
// each surface can say "N locked notes not searched" where the answer would
// have been. Titles still match in quick-open, which reads metas, not bodies.
export async function searchNotes(
  root: string,
  query: string,
  folder: string = "",
): Promise<{ hits: SearchHit[]; lockedSkipped: number }> {
  // The scope narrows the metas before collectHits reads a byte. The cap is
  // "stop after MAX_HITS", so filtering afterwards would let notes outside the
  // folder spend the budget and leave the folder's own matches unread.
  const metas = notesUnder(await listNotes(root), folder);
  const open = metas.filter((m) => !m.locked);
  const hits = await collectHits(query, open, async (path) => (await readNote(path))?.text ?? null);
  return { hits, lockedSkipped: metas.length - open.length };
}

// Backlink context is one result row, not a paragraph.
const CONTEXT_MAX = 200;
function contextOf(lines: string[], line: number): string {
  const text = (lines[line - 1] ?? "").trim();
  return text.length > CONTEXT_MAX ? `${text.slice(0, CONTEXT_MAX)}…` : text;
}

// Every wikilink in the note's own workspace that points at it. One backlink
// definition, shared by the MCP `backlinks` tool and the app's Backlinks panel
// (rpc noteBacklinks), so agents and the UI cannot disagree about who links
// where. The root comes from the path, and the scan is scoped to it because
// wikilinks are: a title in one workspace cannot name a note in another.
// Resolution runs against the same newest-first meta list a linking note's
// editor would use. listNotes' sort is resolveWikiTitle's tie order, so an
// ambiguous title resolves here the way a click in the linking note would.
// Reading every body is searchNotes' accepted cost, and a note deleted
// mid-scan costs that note only.
export async function backlinksTo(path: string): Promise<{ backlinks: BacklinkHit[]; lockedSkipped: number }> {
  const root = assertNote(path);
  const target = resolve(path);
  const metas = await listNotes(root);
  const out: BacklinkHit[] = [];
  let lockedSkipped = 0;
  for (const meta of metas) {
    if (meta.path === target) continue; // a note is not "linked from" itself
    // A locked note's own links sit in a body this scan must not read
    // (searchNotes' skip, same rule). Links pointing at a locked note still
    // resolve: the target's title is plaintext, and the links themselves live
    // in other notes' bodies.
    if (meta.locked) {
      lockedSkipped += 1;
      continue;
    }
    const file = await readNote(meta.path);
    if (file === null) continue;
    const lines = file.text.split("\n");
    for (const ref of wikiRefsOf(file.text)) {
      if (resolveWikiTitle(ref.title, metas)?.path !== target) continue;
      out.push({ ...meta, line: ref.line, context: contextOf(lines, ref.line), raw: ref.raw });
    }
  }
  return { backlinks: out, lockedSkipped };
}

// The text one note contributes to a tag scan. An unlocked note gives its
// whole body, where inline #hashtags live. A locked note gives only its
// plaintext head, so its frontmatter `tags:` line still counts and its body
// hashtags do not (searchNotes' skip above; locking.md §6). Null when the
// note cannot be read, which costs that note and nothing else.
async function tagSourceOf(meta: NoteMeta): Promise<string | null> {
  if (!meta.locked) return (await readNote(meta.path))?.text ?? null;
  return headAt(meta.path);
}

// One workspace's tag directory: the one tag scan, shared by the Tags panel
// (rpc tagList), the overlay's tag rows, the # completion vocabulary, and the
// MCP `tags` tool. Built on listNotes, so listed and tagged cannot drift
// apart; there is no index, so every call rescans. Grammar, aggregation, and
// ordering live in shared/tags.ts. Locked notes count toward lockedSkipped.
export async function tagsIn(root: string, folder: string = ""): Promise<{ tags: TagInfo[]; lockedSkipped: number }> {
  const perNote: { path: string; refs: ReturnType<typeof tagRefsOf> }[] = [];
  let lockedSkipped = 0;
  for (const meta of notesUnder(await listNotes(root), folder)) {
    if (meta.locked) lockedSkipped += 1;
    const text = await tagSourceOf(meta);
    if (text === null) continue;
    perNote.push({ path: meta.path, refs: tagRefsOf(text) });
  }
  return { tags: tagDirectoryOf(perNote), lockedSkipped };
}

// Every occurrence of one tag across a workspace, newest note first: the
// Tags panel's drill-in (rpc tagNotes) and the MCP `tags` tool's second
// mode. Same walk as tagsIn, filtered to one case-folded tag. Rows carry
// line, context, and raw the way backlinksTo's do, for the same reveal. An
// empty tag throws rather than matching nothing: it is a caller bug.
export async function notesTagged(
  root: string,
  tag: string,
  folder: string = "",
): Promise<{ hits: TagHit[]; lockedSkipped: number }> {
  const want = normalizeTag(tag);
  if (!want) throw new Error("empty tag");
  const out: TagHit[] = [];
  let lockedSkipped = 0;
  for (const meta of notesUnder(await listNotes(root), folder)) {
    if (meta.locked) lockedSkipped += 1;
    const text = await tagSourceOf(meta); // locked: head only, tagsIn's rule
    if (text === null) continue;
    const lines = text.split("\n");
    for (const ref of tagRefsOf(text)) {
      if (normalizeTag(ref.tag) !== want) continue;
      out.push({ ...meta, line: ref.line, context: contextOf(lines, ref.line), raw: ref.raw });
    }
  }
  return { hits: out, lockedSkipped };
}

// What readNote hands back. An ordinary note gives its text and disk version.
// A locked note (locking.md) sets `locked`; `held` means the vault is locked,
// so `text` is only the plaintext head: usable as a label, not as the note.
// `damaged` sets `held` too, for a body that fails authentication (edited
// outside Ledge) or a header that will not open. Both cases withhold the body
// rather than handing back ciphertext or plaintext from a failed open.
export interface NoteFile {
  text: string;
  mtimeMs: number;
  locked?: true;
  held?: true;
  damaged?: true;
}

// Read a note, or null when it is gone (deleted outside Ledge, say). The
// mtime is the note's disk version; the view echoes it into writeNote's
// baseMtimeMs so a save can tell its own last state from an external edit.
// The stat runs before the read: a write landing in between leaves the
// reported mtime older than the text, so the next comparison still differs.
//
// A locked note decrypts here, and only here, when the vault is unlocked:
// every app-side content path funnels through this seam (locking.md §4).
// The scans filter on the meta's locked flag before calling, whatever the
// vault state, and the agent surfaces refuse first (mcpTools locate), so a
// decrypted body never reaches them.
export async function readNote(path: string): Promise<NoteFile | null> {
  assertNote(path);
  touchVault();
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const header = parseFrontmatter(raw).params.locked;
  if (header === null) return { text: raw, mtimeMs };
  const { head, body } = splitHead(raw);
  if (vaultState() !== "unlocked") return { text: head, mtimeMs, locked: true, held: true };
  try {
    return { text: head + openBody(header, body), mtimeMs, locked: true };
  } catch (err) {
    // Bad tag, malformed header, foreign-passphrase note: damage, not "gone".
    console.warn("[vault] cannot open locked note", path, err);
    return { text: head, mtimeMs, locked: true, held: true, damaged: true };
  }
}

// What a save reports back: the written file's new disk version, and, when
// the divergence guard below fired, where the overwritten external edit went.
export interface WriteResult {
  mtimeMs: number;
  divergedTo: string | null;
}

/**
 * The bytes a buffer becomes on disk at `path`, and the plaintext they stand
 * for.
 *
 * The disk decides lock state, not the buffer (locking.md §2): the head read
 * settles it. A stray `locked:` line in the buffer is stripped, since honoring
 * it would write a "locked" note whose key nobody holds. A buffer that lost
 * the line still encrypts under the disk's header. Only lockNote and
 * removeLockNote change the state.
 *
 * Its own function because two callers write a buffer into this root. A
 * stashNote that skipped the seal would be the only path in the app that puts
 * a locked note's body on disk in the clear.
 *
 * `outgoing` is what to write. `text` is the same content with the body still
 * in the clear, which is what a divergence comparison runs against: sealing
 * uses a fresh nonce, so a locked note's bytes never match twice.
 *
 * Sealing needs the vault open, and sealBody throws when it is not. Both
 * callers rely on that throw rather than writing plaintext: it keeps a save in
 * the view's autosave retry, and it makes a stash fail with the buffer still
 * in the caller's hands. A save rarely reaches it, because a locked tab shows
 * a placeholder, but a save racing the vault's relock has to fail.
 */
async function sealFor(path: string, text: string): Promise<{ outgoing: string; text: string; header: string | null }> {
  const diskHead = await headAt(path);
  const header = diskHead === null ? null : parseFrontmatter(diskHead).params.locked;
  if (header === null) {
    const stripped = stripLockedLine(text);
    if (stripped !== text) console.warn("[vault] dropped a locked: line from a save to an unlocked note:", path);
    return { outgoing: stripped, text: stripped, header };
  }
  const { head, body } = splitHead(stampLockedLine(text, header));
  return { outgoing: head + sealBody(header, body) + "\n", text: head + body, header };
}

// Atomic save: write a temp file in the same directory, then rename(2) over
// the target. rename is atomic within a filesystem, so a crash or a `kill -9`
// mid-save leaves either the old note or the new one, never half a file. The
// temp name is dotted so a concurrent listNotes never shows it.
//
// `baseMtimeMs` is the caller's expectation: the disk version it last read or
// wrote. When the file's actual mtime disagrees and the bytes genuinely
// differ, something else wrote here since (an agent in the note's own
// terminal, git, vim). The buffer still wins the live path, because its author
// is the one typing. The external version is moved into the root's trash via
// deleteNote rather than destroyed, the same rename-not-unlink stance as every
// delete, so a concurrent edit costs a trip to the Trash section. Identical
// bytes just adopt the disk mtime: no write, no trash noise. null means no
// expectation (a note edited before its first read landed) and writes blind.
//
// The returned mtime is the temp file's, statted before the rename, which
// preserves it. Statting after the rename could catch a foreign write that
// landed in between and report that writer's version as this save's. The
// stat-then-rename window on the guard itself stays open, since POSIX rename
// has no exchange primitive, but the guard aims at the seconds or minutes an
// agent edit sits unnoticed, not at microsecond interleavings.
let tmpCounter = 0;
export async function writeNote(path: string, text: string, baseMtimeMs: number | null = null): Promise<WriteResult> {
  const root = assertWritableRoot(assertNote(path));
  touchVault();
  await rootReady(root);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const sealed = await sealFor(path, text);
  const { outgoing } = sealed;
  const diskHeader = sealed.header;
  text = sealed.text;

  let divergedTo: string | null = null;
  if (baseMtimeMs !== null) {
    const disk = await stat(path).catch(() => null); // gone is not a conflict: the write recreates it
    if (disk && disk.mtimeMs !== baseMtimeMs) {
      const current = await readFile(path, "utf8").catch(() => null);
      // For a locked note the comparison is plaintext-equivalent, not byte
      // equality: sealing uses a fresh nonce, so the bytes always differ.
      // Decrypt the disk body. A body that will not open (edited outside
      // Ledge) counts as different and takes the trash trip like any foreign
      // write.
      const same = (() => {
        if (current === null) return false;
        if (diskHeader === null) return current === text;
        try {
          const d = splitHead(current);
          return d.head + openBody(parseFrontmatter(current).params.locked ?? diskHeader, d.body) === text;
        } catch {
          return false;
        }
      })();
      if (same) return { mtimeMs: disk.mtimeMs, divergedTo: null };
      if (current !== null) divergedTo = await deleteNote(path); // a locked note's copy moves as ciphertext
    }
  }
  tmpCounter += 1;
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, outgoing, "utf8");
    const mtimeMs = (await stat(tmp)).mtimeMs;
    await rename(tmp, path);
    return { mtimeMs, divergedTo };
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// --- locking ----------------------------------------------------------------

// Whether the disk says this note is locked. The head read is the whole
// answer, since the flag lives in the plaintext frontmatter. The prompt-fence
// refusal and the pasted-image seal both call this (bun/server.ts): cheap
// enough to ask per run, and fresh enough that a just-locked note refuses
// immediately.
export async function isNoteLocked(path: string): Promise<boolean> {
  assertNote(path);
  const head = await headAt(path);
  return head !== null && parseFrontmatter(head).params.locked !== null;
}

// The probe an unlock falls back to when no vault file exists (synced-in
// locked notes, locking.md §3): any locked note's self-contained header. The
// first hit wins, and the scan reads heads only.
export async function firstLockedHeader(rootsToScan: string[]): Promise<string | undefined> {
  for (const root of rootsToScan) {
    try {
      for (const meta of await listNotes(root)) {
        if (!meta.locked) continue;
        const head = await headAt(meta.path);
        const header = head === null ? null : parseFrontmatter(head).params.locked;
        if (header !== null) return header;
      }
    } catch {
      // an unlistable root is skipped, the boot fetch's stance
    }
  }
  return undefined;
}

// The in-root image references a note's text carries (`![](…)`): the set the
// lock sweep seals and Remove Lock unseals. Resolution reuses the asset
// guard, against the note's own folder. A reference that fails it (a remote
// URL, a traversal out of the root, a non-image) is not an asset and is not
// swept.
//
// Both halves come back because the two sweeps below need different ones. The
// ref is what a person reads in the shared-image notice. The path is
// identity: references are note-relative (assets.ts), so two notes in
// different folders write the same file differently (`.ledge-assets/x.png`
// from the root, `../.ledge-assets/x.png` from a subfolder). Comparing
// reference strings would miss the sharing note, so Remove Lock would unseal
// an image a locked note still shows. Keying by path also collapses two
// references to one file into a single seal.
const IMAGE_REF = /(!\[[^\]]*\]\()([^()\s]+)(\))/g;
interface AssetRef {
  /** The reference as the note writes it, for the notice. */
  ref: string;
  /** The file it names, resolved: what two notes are compared on. */
  path: string;
}
function assetRefsOf(text: string, root: string, from: string): AssetRef[] {
  const out = new Map<string, string>();
  for (const m of text.matchAll(IMAGE_REF)) {
    const ref = m[2]!;
    try {
      const path = assetPathOf(root, ref, from);
      if (!out.has(path)) out.set(path, ref);
    } catch {
      // not an in-root image reference
    }
  }
  return [...out].map(([path, ref]) => ({ ref, path }));
}

/**
 * The note's text with its in-root image references rewritten for a new
 * location. A reference is relative to the note (assets.ts), so moving the
 * file changes what every one resolves to: `.ledge-assets/x.png` in a note
 * moved into `trips/` would name a `trips/.ledge-assets` that does not exist,
 * and every picture in the note would break.
 *
 * Only references that resolve from the old location are touched, and each is
 * re-emitted for the new one. A remote URL or a non-image is left as written,
 * since neither is an asset. Whether the file is on disk is not checked: a
 * reference to an image not pasted yet still travels with the note instead of
 * being left aiming at the old folder.
 *
 * deleteNote needs none of this and still just renames. A delete and its
 * restore change the depth by the same one segment in opposite directions, so
 * a reference that is wrong while the note sits in `.ledge-trash` is right
 * again the moment it comes back, and nothing renders a trashed note in
 * between.
 */
function rebaseAssetRefs(text: string, root: string, from: string, to: string): string {
  if (dirname(resolve(from)) === dirname(resolve(to))) return text;
  return text.replace(IMAGE_REF, (whole, open: string, ref: string, close: string) => {
    let asset: string;
    try {
      asset = assetPathOf(root, ref, from);
    } catch {
      return whole; // not an in-root image reference
    }
    return `${open}${assetRefFor(root, asset, to)}${close}`;
  });
}

// Mark a note as one of its workspace's favorites, or unmark it: one line of
// the frontmatter changes (shared/frontmatter.ts setFavoriteLine) and every
// other byte is preserved, because the rest of the block is the user's.
//
// The file's own bytes are edited rather than a decrypted buffer. The marker
// sits in the plaintext head beside the note's tags, so a locked note is
// favorited with the vault shut and no body is read or written (locking.md
// §2). writeSealed is the write, for its own half of that function's job: a
// foreign edit that landed since the read goes to the trash instead of being
// overwritten by bytes from a moment ago.
//
// Already-the-asked-for-way is the outcome asked for, as in lockNote: the
// listing a command fired from can be a beat stale, and a second Favorite must
// not rewrite the file to say what it already says.
export async function favoriteNote(path: string, on: boolean): Promise<NoteMeta> {
  assertWritableRoot(assertNote(path)); // the manual's pages take no marker
  touchVault();
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`no note at ${path}`);
  }
  const next = setFavoriteLine(raw, on);
  if (next !== raw) await writeSealed(path, next, mtimeMs);
  return metaAt(path);
}

// Lock a note: mint its header (a random data key wrapped by the master key,
// salt copied in), stamp the line, seal the body, and sweep its images
// (locking.md §5). Every in-root image the note references is sealed in place
// under its own name, wrapped by the master key, so a screenshot is as sealed
// as the prose around it.
//
// An image an unlocked note also shows is sealed anyway, and `sealedShared`
// names it so the user hears about it. Refusing instead would deadlock the
// "lock both sharing notes" flow, since each note would block on the other.
// The other note's widget shows the locked face until the vault is unlocked.
//
// Requires the vault unlocked; the RPC layer runs vault creation first on the
// very first lock. A template is refused here, not only in the UI: a
// template's body exists to be stamped into new notes, and the MCP template
// path must not reach a locked one however the marker arrived.
export async function lockNote(path: string): Promise<{ meta: NoteMeta; sealedShared: string[] }> {
  assertWritableRoot(assertNote(path)); // lock/unlock write via writeSealed, not writeNote
  const file = await readNote(path);
  if (file === null) throw new Error(`no note at ${path}`);
  if (file.locked) return { meta: await metaAt(path), sealedShared: [] }; // already locked: the outcome asked for
  const params = parseFrontmatter(file.text).params;
  if (params.template) throw new Error("a template cannot be locked — remove its template: marker first (its body exists to be copied into new notes)");
  const header = mintLockedHeader(); // throws when the vault is locked

  const root = assertNote(path);
  const refs = assetRefsOf(file.text, root, path);
  const sealedShared: string[] = [];
  if (refs.length > 0) {
    const mine = new Map(refs.map((r) => [r.path, r.ref]));
    for (const meta of await listNotes(root)) {
      if (resolve(meta.path) === resolve(path) || meta.locked) continue;
      const other = await readNote(meta.path);
      if (other === null) continue;
      // Each note's refs resolve against its own folder, then intersect on
      // the file. Comparing the strings would answer "no" for the same image
      // in two folders, and the sweep would seal it without saying so.
      for (const r of assetRefsOf(other.text, root, meta.path)) {
        const ref = mine.get(r.path);
        if (ref !== undefined) sealedShared.push(`${ref} (also shown by "${meta.title}")`);
      }
    }
    for (const r of refs) {
      const bytes = await rawAssetBytes(r.path);
      if (bytes === null || isSealedAsset(bytes)) continue; // gone, or already sealed
      await replaceAssetBytes(r.path, sealAssetBytes(bytes));
    }
  }

  const stamped = stampLockedLine(file.text, header);
  const { head, body } = splitHead(stamped);
  await writeSealed(path, head + sealBody(header, body) + "\n", file.mtimeMs);
  return { meta: await metaAt(path), sealedShared: [...new Set(sealedShared)] };
}

// Remove a note's lock: decrypt, strip the line, write plaintext. The image
// sweep reverses too, except for assets another locked note still references.
// Those stay sealed, so this note's widget shows the sealed placeholder until
// the vault is open. This is the only path that decrypts to disk, and only a
// command reaches it: a text edit cannot, since writeNote above re-stamps.
export async function removeLockNote(path: string): Promise<NoteMeta> {
  assertWritableRoot(assertNote(path)); // writeSealed path, like lockNote
  const file = await readNote(path);
  if (file === null) throw new Error(`no note at ${path}`);
  if (!file.locked) return metaAt(path); // already plain
  if (file.held) {
    throw new Error(file.damaged ? "this note's locked body is damaged; restore the file from a backup first" : "unlock first");
  }
  const root = assertNote(path);
  const refs = assetRefsOf(file.text, root, path);
  if (refs.length > 0) {
    // Which images stay sealed: those any other locked note still references.
    // The vault is open here (file.held was false), so their bodies decrypt.
    // Claims are collected as resolved paths, never as reference strings. A
    // locked note one folder away writes the same image a different way, so a
    // string comparison would miss its claim and unseal an image it shows.
    const claimed = new Set<string>();
    for (const meta of await listNotes(root)) {
      if (resolve(meta.path) === resolve(path) || !meta.locked) continue;
      const other = await readNote(meta.path);
      if (other === null || other.held) continue;
      for (const r of assetRefsOf(other.text, root, meta.path)) claimed.add(r.path);
    }
    for (const r of refs) {
      if (claimed.has(r.path)) continue;
      const bytes = await rawAssetBytes(r.path);
      if (bytes === null || !isSealedAsset(bytes)) continue;
      try {
        await replaceAssetBytes(r.path, openAssetBytes(bytes));
      } catch (err) {
        // A damaged sealed image stays sealed. The note's own text still
        // unlocks.
        console.warn("[vault] could not unseal image during Remove Lock", r.ref, err);
      }
    }
  }
  await writeSealed(path, stripLockedLine(file.text), file.mtimeMs);
  return metaAt(path);
}

// Change the vault passphrase: a new salt, a new master key, and a rewrite of
// every locked note's header and every sealed image's key wrap across the given
// roots. Headers and wraps only, never a body byte, since the per-note data
// keys do not change. The commit lands after the sweep, so a crash leaves the
// old vault file and a partial sweep: the headers already rewrapped will not
// open under the old passphrase until the change is re-run. Re-running finishes
// the job, and nothing is lost. rewrapHeader throws on a header that has
// already moved, and the loop reports and skips it.
export async function changeVaultPassphrase(newPassphrase: string, rootsToScan: string[]): Promise<number> {
  const { oldKey, newKey, newSalt } = await beginPassphraseChange(newPassphrase);
  let rewrapped = 0;
  for (const root of rootsToScan) {
    let metas: NoteMeta[];
    try {
      metas = await listNotes(root);
    } catch {
      continue; // skip an unlistable root, the boot fetch's stance
    }
    for (const meta of metas) {
      if (!meta.locked) continue;
      try {
        const raw = await readFile(meta.path, "utf8");
        const header = parseFrontmatter(raw).params.locked;
        if (header === null) continue;
        await writeSealed(meta.path, stampLockedLine(raw, rewrapHeader(header, oldKey, newKey, newSalt)), (await stat(meta.path)).mtimeMs);
        rewrapped += 1;
      } catch (err) {
        console.warn("[vault] could not rewrap", meta.path, err);
      }
    }
    // Sealed images: any in-root image file carrying the magic. The walk is
    // listNotes' walk (dot-entries skipped) plus the app's own assets
    // directory, which is dotted so listings never show it.
    for (const path of await imageFilesUnder(root)) {
      try {
        const bytes = await readFile(path);
        if (!isSealedAsset(bytes)) continue;
        await replaceAssetBytes(path, rewrapAssetBytes(bytes, oldKey, newKey, newSalt));
        rewrapped += 1;
      } catch (err) {
        console.warn("[vault] could not rewrap sealed image", path, err);
      }
    }
  }
  await commitPassphraseChange(newKey, newSalt);
  return rewrapped;
}

// Every image file the passphrase sweep must consider: the root's dotted
// .ledge-assets pool, plus non-dotted in-root images. The lock sweep may have
// sealed any of those, since a note can reference `img/x.png`.
async function imageFilesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ASSETS_DIRNAME) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && imageMimeOf(path) !== null) out.push(path);
    }
  };
  await walk(resolve(root));
  return out;
}

// The lock and unlock writes: temp-plus-rename, shaped like writeNote's
// divergence guard but with none of its comparison. These are whole-state
// transitions taken from a just-read version, so a foreign write since then
// simply moves to the trash (rename-not-unlink, architecture.md §3).
async function writeSealed(path: string, outgoing: string, baseMtimeMs: number): Promise<void> {
  const dir = dirname(path);
  const disk = await stat(path).catch(() => null);
  if (disk && disk.mtimeMs !== baseMtimeMs) {
    const moved = await deleteNote(path);
    if (moved) console.warn("[vault] concurrent edit preserved in trash during a lock state change:", moved);
  }
  tmpCounter += 1;
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, outgoing, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// Names handed out by createNote but not yet on disk. Two notes can reach their
// first save in the same tick, and the readdir that computes the next free name
// would hand both of them the same one. Reserving between the readdir and the
// write closes that window (nothing awaits in between). The map is keyed by the
// directory a name is allocated in, because the same slug in two workspaces is
// two different files and one global set would push one of them to -2.
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
// content. Called on a note's first edit, not when its tab opens, so a tab
// nobody types in leaves nothing behind. The name comes from the note's H1
// when it has one by then: a note titled before its first save is never
// created as untitled.md and renamed a moment later.
export async function createNote(root: string, text: string, folder?: string | null): Promise<NoteMeta> {
  // ensureFolder carries three checks: the write guard, the root's readiness,
  // and the folder guard. The write guard runs before any name is allocated,
  // so a refusal names the act ("create in the docs folder"). With no folder
  // the answer is the root, where every note landed before folders existed.
  const dir = await ensureFolder(root, folder);
  const reserved = reservedIn(dir);
  const taken = new Set(await readdir(dir));
  for (const name of reserved) taken.add(name);
  const name = uniqueName(baseFor(text), taken);
  reserved.add(name);
  const path = join(dir, name);
  try {
    await writeNote(path, text);
  } finally {
    reserved.delete(name);
  }
  return metaFor(path, text);
}

// Move a note into another folder of its own workspace, keeping its name.
//
// Within one root by construction, so this is a rename(2) like every other move
// in this file: atomic, and free of EXDEV even when the workspace sits on
// another volume. Cross-workspace moves are not offered. A note's root decides
// its wikilink scope, its tag directory, its assets pool and its trash, so
// moving between roots is four migrations rather than a rename.
//
// The docId is untouched, as in retitleNote, so the note's editor, undo history
// and running shell survive the move (architecture.md §4). Moving a note that
// is open on screen is therefore safe.
//
// A trashed note is refused rather than moved. Restore is the call that knows
// which folder the note came from, and letting a move double as an untrash
// would leave that origin recorded nowhere.
export async function moveNote(path: string, folder: string | null): Promise<NoteMeta> {
  const root = assertWritableRoot(assertNote(path));
  const from = resolve(path);
  if (isInside(trashDirOf(root), from)) {
    throw new Error("that note is in the trash — restore it first, then move it");
  }
  const dir = await ensureFolder(root, folder);
  if (dirname(from) === dir) return metaAt(from); // already there: the outcome asked for

  // Read before the rename, because the move rewrites the note's image
  // references for its new folder (rebaseAssetRefs). A locked note whose vault
  // is shut cannot be read, so it is refused: moving it anyway would leave its
  // pictures pointing at nothing with no sign of it. The refusal reuses Remove
  // Lock's "unlock first" wording, and the vault is its only cause.
  const file = await readNote(from);
  if (file === null) throw new Error(`no note at ${path}`);
  if (file.held) {
    throw new Error(
      file.damaged
        ? "this note's locked body is damaged; restore the file from a backup first"
        : "unlock first — moving a locked note rewrites the image references in its body",
    );
  }

  const reserved = reservedIn(dir);
  const taken = new Set(await readdir(dir));
  for (const name of reserved) taken.add(name);
  // uniqueName against the destination, because rename(2) clobbers silently
  // (architecture.md §3). The note keeps the name its heading gave it. Only a
  // collision in the destination adds a suffix.
  const name = uniqueName(titleOf(from), taken);
  // Held across the rename for createNote's reason: the readdir above is an
  // await, so a second move into this folder can read the same snapshot and
  // allocate the same name before this one lands.
  reserved.add(name);
  const target = join(dir, name);
  try {
    assertNote(target);
    await rename(from, target);
    // After the rename, so the write lands on the note where it now lives.
    // rename(2) preserves mtime, so `file.mtimeMs` is still the expectation
    // writeNote holds against a foreign edit. writeNote re-seals a locked
    // note's body on the way out, so this hands it plaintext.
    const rebased = rebaseAssetRefs(file.text, root, from, target);
    if (rebased !== file.text) await writeNote(target, rebased, file.mtimeMs);
  } finally {
    reserved.delete(name);
  }
  return metaAt(target);
}

// Whether two directory entries are the same directory. A case-only rename
// looks like this on a case-insensitive filesystem, which APFS is by default:
// `projects` and `Projects` are one folder, and `stat` answers for both.
// renameFolder asks because "already exists" would be the wrong thing to say
// about the folder it is renaming.
async function sameEntry(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  return x !== null && y !== null && x.dev === y.dev && x.ino === y.ino;
}

/** Is there a directory here? A missing path and a file both answer no. */
async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/**
 * Rename a folder: one rename(2) of the directory, atomic however many notes
 * are under it, not a move of every note in it. The name changes and the parent
 * does not, so no note changes depth. Image references are relative to the note
 * (assets.ts), so every one is still right, and the asset pool is one flat
 * directory per root, so nothing there moves. No note's bytes are read or
 * written, which is also why a locked note rides along with its vault shut
 * where `moveNote` has to refuse one (architecture.md §3).
 *
 * What comes back is the notes' old metadata with new paths rather than a
 * re-read. rename(2) moves a directory entry and touches no file inside it, so
 * the titles, tags, locks and mtimes `listNotes` just read are still true.
 *
 * `name` is one segment and not a path (shared/folders.ts folderLeafProblem).
 * Moving a folder elsewhere is a different verb: it asks which parent, and it
 * would have to rebase every note it moved.
 */
export async function renameFolder(
  root: string,
  folder: string,
  name: string,
): Promise<{ folder: string; moved: Array<{ from: string; note: NoteMeta }> }> {
  const r = assertWritableRoot(assertRegisteredRoot(root));
  await rootReady(r);
  const scope = folderScopeOf(folder);
  const from = folderPathOf(r, scope);
  if (from === r) throw new Error("the workspace's own folder is renamed in the workspace strip, not here");
  if (!(await isDir(from))) throw new Error(`there is no "${scope}" folder in this workspace`);

  const problem = folderLeafProblem(name);
  if (problem !== null) throw new Error(`not a folder name: ${name} (${problem})`);
  const to = join(dirname(from), name.trim());
  if (to === from) return { folder: scope, moved: [] }; // the outcome asked for
  const newFolder = relative(r, to).split(sep).join("/");

  // rename(2) clobbers a directory quietly when it can: onto an empty one it
  // succeeds and swallows it, onto a full one it fails with a raw ENOTEMPTY.
  // Neither is a usable answer, so the destination is checked here. The one
  // exception is a destination that is the source (sameEntry), which is what a
  // case-only rename looks like, and fixing a name's case is a valid rename.
  if ((await isDir(to)) && !(await sameEntry(from, to))) {
    throw new Error(
      `there is already a folder called "${name.trim()}" here — one holding no notes is not in the list, but it is still on disk`,
    );
  }
  // ensureFolder's check, for ensureFolder's reason: a note that listNotes
  // will never show has silently disappeared, and renaming a folder into an
  // ignored name would take every note in it off the list at once. Only the
  // new name is checked. The parent is unchanged and on screen, so it is not
  // ignored.
  const ignore = await loadIgnore(r);
  if (ignore.ignores(newFolder, true)) {
    throw new Error(
      `"${newFolder}" is ignored in this workspace, so its notes would disappear from the list (see .ledgeignore)`,
    );
  }

  // Listed before the rename, because this is the call that knows which notes
  // were in the folder. Afterwards they are somewhere else, and nothing
  // records where they came from.
  const before = notesUnder(await listNotes(r), scope);
  await rename(from, to);
  const moved = before.map((note) => {
    const path = join(to, relative(from, note.path));
    return { from: note.path, note: { ...note, path, folder: folderOf(r, path) } };
  });

  // The trash mirrors the workspace's folders (architecture.md §3), so it
  // follows the rename. Without this, deleting a note out of `projects`,
  // renaming the folder to `work` and then pressing Undo would restore that
  // note into a resurrected `projects` beside the `work` it came from.
  //
  // Afterwards and best-effort: the rename the user asked for has already
  // happened, so a mirror that will not move is no reason to report the rename
  // as failed. An existing destination is left alone rather than merged,
  // because those notes were deleted from a folder that really was called that,
  // and a restore puts a note back where it came from.
  const mirror = join(trashDirOf(r), scope);
  const mirrorTo = join(trashDirOf(r), newFolder);
  if ((await isDir(mirror)) && (!(await isDir(mirrorTo)) || (await sameEntry(mirror, mirrorTo)))) {
    await rename(mirror, mirrorTo).catch((err) => {
      console.warn("[notes] renamed the folder but not its trash", err);
    });
  }

  return { folder: newFolder, moved };
}

// Move a note's file to match its heading. Returns the note where it now lives,
// which may be the path it was already at. `text` is the note's whole markdown
// and not a title: baseFor slugs the first-line H1 out of it, and text without
// one becomes untitled.md. The docId is untouched, so the note's editor, undo
// history and running shell all survive the rename (architecture.md §4). That
// is what makes naming-by-heading safe despite PLAN D15's warning
// (shared/slug.ts).
export async function retitleNote(path: string, text: string): Promise<NoteMeta> {
  assertWritableRoot(assertNote(path));
  const dir = dirname(path);
  const current = basename(path);
  const reserved = reservedIn(dir);

  // Drop the note's own name from the taken set. Without this, a note already
  // sitting at shipping-notes-2.md (because another note holds
  // shipping-notes.md) would count its own name as taken and climb to -3, -4,
  // -5 on every heading edit.
  const taken = new Set(await readdir(dir));
  taken.delete(current);
  for (const name of reserved) taken.add(name);

  const name = uniqueName(baseFor(text), taken);
  if (name.toLowerCase() === current.toLowerCase()) {
    // Already correctly named, or uniqueName landed back on its own name.
    return metaFor(path, text);
  }

  // uniqueName skipped every name in `dir`, so this rename cannot clobber
  // another note. rename(2) would clobber one silently, so the check belongs in
  // the name allocation rather than here. The target stays in `dir`, so it is
  // inside the same root already; assertNote re-checks anyway.
  const target = join(dir, name);
  assertNote(target);
  await rename(path, target);
  return metaFor(target, text);
}

// Where inside the trash a note's file goes. The trash mirrors the workspace's
// folders (architecture.md §3): a note deleted from `projects/api` lands in
// `.ledge-trash/projects/api`, and that path is the whole record of where it
// came from. No sidecar index to keep in step, nothing to prune, and an
// external tool looking at the folder sees what Ledge sees. A note inside a
// dot-folder flattens to the trash's top level, because trashFiles skips
// dot-entries and would never list it again.
function trashSubdirOf(root: string, path: string): string {
  const trashDir = trashDirOf(root);
  const segments = visibleSegmentsUnder(resolve(root), dirname(resolve(path)));
  return segments === null || segments.length === 0 ? trashDir : join(trashDir, ...segments);
}

const TRASH_GITIGNORE = "# Deleted notes stay out of git.\n*\n";

// The trash directory a delete writes into, with the ignore file that keeps
// the trash out of git. Deleted notes wait out TRASH_TTL_MS here, so a
// `git add -A` that committed them would hold them in the log long past the
// purge. One `*` covers the whole directory, which is what lets a workspace
// attached from an existing repo need no edit to its own .gitignore.
async function ensureTrashDir(root: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // `wx` rather than a plain write: this runs on every delete, and a user who
  // edited the file keeps their version. A failure leaves the delete alone.
  const marker = join(trashDirOf(root), GITIGNORE);
  await writeFile(marker, TRASH_GITIGNORE, { encoding: "utf8", flag: "wx" }).catch(() => {});
}

// Delete a note by renaming it into the trash rather than unlinking it. Same
// rename(2) as a save, so it is atomic, and a misclick costs a trip to the
// Trash section rather than the note. The trash is the note's own root's, so
// the move never crosses a filesystem boundary. Returns where the note landed
// (null when there was nothing to delete), so the caller can offer an undo.
export async function deleteNote(path: string): Promise<string | null> {
  const root = assertWritableRoot(assertNote(path));
  const trashDir = trashDirOf(root);
  if (isInside(trashDir, path)) return null; // already trashed
  const destDir = trashSubdirOf(root, path);
  await ensureTrashDir(root, destDir);
  const taken = new Set(await readdir(destDir));
  const dest = join(destDir, uniqueName(titleOf(path), taken));
  try {
    await rename(path, dest);
  } catch (err) {
    // Already gone (deleted in Finder, say) is the outcome the caller wanted.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
  return dest;
}

/**
 * Delete a folder by deleting the notes in it: every one, at any depth, each
 * by the same rename into the trash a single delete uses. The folder leaves
 * the list because nothing is in it any more, since a folder is a row only
 * while notes are in it (mainview/notes/folders.ts).
 *
 * Not one rename(2) of the directory into the trash, though that is what
 * `renameFolder` does and it would be cheaper. The trash mirrors the
 * workspace's folders (architecture.md §3), so for everything `listNotes`
 * shows the two land in the same place. A directory move also carries what the
 * list does not show (a dot-folder, a `.ledgeignore`d subtree, an image, any
 * file that is not a note) somewhere `trashFiles` will not list it, which
 * buries it rather than deleting it.
 *
 * Moving exactly the notes the list showed gives each one its own trashed
 * identity: it lands in its own folder's mirror under a free name, the Trash
 * section lists it, and Restore reads its origin off that path and rebuilds
 * the folder around it. Undoing a folder delete is N restores rather than a
 * second mechanism (notes/actions.ts).
 *
 * A locked note goes with its vault shut, for renameFolder's reason: this
 * moves files and reads no body.
 */
export async function deleteFolder(
  root: string,
  folder: string,
): Promise<{ trashed: Array<{ from: string; to: string }> }> {
  const r = assertWritableRoot(assertRegisteredRoot(root));
  await rootReady(r);
  const scope = folderScopeOf(folder);
  const dir = folderPathOf(r, scope);
  // The root is not a folder row and has no delete. A workspace is closed from
  // the workspace strip, which detaches the folder and unlinks nothing.
  if (dir === r) throw new Error("a workspace is closed from the workspace strip, not deleted here");
  if (!(await isDir(dir))) throw new Error(`there is no "${scope}" folder in this workspace`);

  // Listed before anything moves. That list is the authority on what this call
  // may touch, and it comes from listNotes: the same walk the sidebar's folder
  // rows are built from (mainview/notes/folders.ts folderList).
  const trashed: Array<{ from: string; to: string }> = [];
  for (const note of notesUnder(await listNotes(r), scope)) {
    const to = await deleteNote(note.path);
    // null means already gone: deleted in Finder between the walk and here.
    // That is the outcome asked for, but there is nothing to offer back.
    if (to !== null) trashed.push({ from: note.path, to });
  }

  await pruneEmptyDirs(dir);
  return { trashed };
}

/**
 * Remove a deleted folder's directories, deepest first, now that their notes
 * are in the trash.
 *
 * `rmdir` refuses a directory with anything left in it, and that refusal is
 * the guard rather than an error to handle. Whatever is still in there is
 * something this call was never allowed to move (an image, an ignored subtree,
 * a dot-folder), so the directory stays and none of it is touched. Best-effort
 * throughout, since the notes are already in the trash.
 *
 * This unlinks no file, so it joins none of the three lists in architecture.md
 * §3. It earns its place because an emptied directory is invisible to
 * `listNotes`: a later `renameFolder` onto that name would be refused by a
 * folder the user believes they deleted.
 */
async function pruneEmptyDirs(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await pruneEmptyDirs(join(dir, entry.name));
  }
  await rmdir(dir).catch(() => {});
}

/**
 * Park text in a root's trash without it ever having been a note.
 *
 * The case is a buffer typed while its server could not be reached, and
 * overtaken on the server since (remote.md §7). It is somebody's writing, it is
 * not what the note says any more, and there is nowhere on the live path for it
 * to go. deleteNote cannot take it: deleteNote moves a file, and this has never
 * been one.
 *
 * The trash rather than a new note, and named exactly as a delete names one,
 * because restoreNote then lands it beside the live note under a free name
 * rather than over it. That leaves both versions on screen, and the user makes
 * the merge. Giving it a name of its own would add a second kind of thing to
 * the Trash section.
 *
 * Sealed like a save (sealFor), because the trash is inside the root and a
 * locked note's stranded buffer is plaintext in memory. A stash whose vault has
 * relocked throws, and the caller keeps the buffer rather than losing it.
 */
export async function stashNote(path: string, text: string): Promise<string> {
  const root = assertWritableRoot(assertNote(path));
  touchVault();
  await rootReady(root);
  const { outgoing } = await sealFor(path, text);
  // The note's own folder, mirrored, exactly as a delete records it. A restore
  // has to land beside the live note, which means in the note's own folder.
  const destDir = trashSubdirOf(root, path);
  await ensureTrashDir(root, destDir);
  const taken = new Set(await readdir(destDir));
  const dest = join(destDir, uniqueName(titleOf(path), taken));
  await writeFile(dest, outgoing, "utf8");
  return dest;
}

// --- trash ------------------------------------------------------------------

// Only .md files inside the root's trash count, at any depth. The trash mirrors
// the workspace's folders (trashSubdirOf), so a deleted note may sit several
// levels down. Anything else in there arrived by some route other than a delete
// and is left alone: Empty removes what the list showed and nothing else.
//
// The walk skips dot-entries, the way listNotes does. assertTrashed accepts
// exactly what this yields, so the guard on the two unlink paths and the
// listing they act on cannot drift apart.
async function trashFiles(root: string): Promise<Array<{ path: string; stat: Stats }>> {
  const out: Array<{ path: string; stat: Stats }> = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // no trash folder yet: nothing has ever been deleted here
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!/\.md$/i.test(entry.name)) continue;
      const s = await stat(path).catch(() => null);
      if (s?.isFile()) out.push({ path, stat: s });
    }
  };
  await walk(trashDirOf(root));
  return out;
}

// One workspace's trashed notes, newest deletion first.
//
// `deletedAt` is the file's ctime: the inode's change time, which rename(2)
// updates and nothing afterwards touches, so for a file sitting in the trash it
// is the moment it was deleted. mtime is the last edit, so a note written
// months ago and deleted today would look ancient and be purged at once.
// Stamping mtime with utimes on the way in would overwrite the note's real
// last-edited time, and a restored note would come back claiming it was edited
// the instant it was deleted. ctime cannot be set at all. Copying the folder
// wholesale (restoring a backup) does reset it, and those entries then get
// another TTL's worth of time in the trash.
export async function listTrash(root: string): Promise<TrashMeta[]> {
  const files = await trashFiles(assertRegisteredRoot(root));
  const out: TrashMeta[] = [];
  for (const { path, stat: s } of files) {
    const head = await headAt(path);
    out.push({ path, title: labelOf(head === null ? null : headingOf(head), path), deletedAt: s.ctimeMs });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

// A trashed note must be a .md file visibly inside its root's trash, at any
// depth. Stricter than the containment check live notes get, because restore
// and empty are the two calls that can move or unlink a file: bare containment
// would also accept the trash folder itself, and a dot-segment would accept a
// file no listing ever showed.
//
// At any depth rather than directly inside the trash, because a delete can put
// a note in `.ledge-trash/projects`: the tighter rule refused to restore or
// empty exactly the notes the mirroring was for. `visibleSegmentsUnder` is the
// same rule trashFiles walks by, so the guard accepts precisely the set the
// Trash section listed (testing.md §3 names this invariant).
//
// Returns the root whose trash holds the note.
function assertTrashed(path: string): string {
  const root = rootContaining(path);
  if (!root || visibleSegmentsUnder(trashDirOf(root), path) === null || !/\.md$/i.test(path)) {
    throw new Error(`not a trashed note: ${path}`);
  }
  return root;
}

// Move a note back out of the trash, into the folder it was deleted from. Its
// old name may have been taken by a note created since, so the name is
// allocated fresh rather than assumed free: this is a rename(2) like any
// other, and rename(2) clobbers silently.
//
// The note's path inside the trash is the record of which folder it belongs
// to, since the trash mirrors the workspace's folders. A folder emptied since
// the delete is recreated on the way back, rather than dropping the note at the
// top level and undoing a filing decision.
//
// The trash's now-empty folder is left behind. Removing it would add an rmdir
// to a path whose job is to be reversible, for a directory no listing shows
// (trashFiles yields nothing for an empty one).
export async function restoreNote(path: string): Promise<NoteMeta> {
  // Belt: no delete can put a note in the docs root's trash, but a restore
  // writes into its root, so the write guard is checked here too.
  const root = assertWritableRoot(assertTrashed(path));
  await rootReady(root);
  // Straight from the mirrored path, not through folderPathOf. This folder was
  // recorded by a delete rather than typed by a caller, and assertTrashed has
  // already established that the path is visibly inside the trash.
  // Re-validating a name the app wrote adds only a way for a restore to fail.
  const rel = relative(trashDirOf(root), dirname(resolve(path)));
  const dir = rel === "" ? root : join(root, rel);
  await mkdir(dir, { recursive: true });
  const reserved = reservedIn(dir);
  const taken = new Set(await readdir(dir));
  for (const name of reserved) taken.add(name);
  // Reserved across the rename, like every other allocation into a directory
  // (createNote). A restore that read the reserved set without joining it would
  // let two restores into one folder in the same tick pick the same name.
  const name = uniqueName(titleOf(path), taken);
  reserved.add(name);
  const target = join(dir, name);
  try {
    assertNote(target);
    await rename(path, target);
  } finally {
    reserved.delete(name);
  }
  return metaAt(target);
}

// Unlink one trashed note, for good. assertTrashed is the only guard: it is
// the difference between deleting a note the user pointed at in the Trash
// section and deleting an arbitrary file the view named. Returns false if the
// file was already gone, which is the outcome the caller wanted anyway.
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

// Unlink every trashed note in one workspace, for good. This and deleteTrashed
// are the destructive calls a user reaches directly in this file, so the UI
// puts a modal confirmation in front of both (interactions.md §4).
export async function emptyTrash(root: string): Promise<number> {
  return removeAll(await trashFiles(assertRegisteredRoot(root)));
}

// Drop one workspace's trashed notes past the TTL: a delete nobody remembers
// is the kind that should age out. Called once per available root at startup
// (server.ts) rather than on a timer, so a note never leaves the Trash section
// while someone is looking at it.
export async function purgeTrash(root: string, ttlMs: number = TRASH_TTL_MS): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  const files = await trashFiles(root);
  return removeAll(files.filter((f) => f.stat.ctimeMs < cutoff));
}

// Best-effort: a file that has vanished, or that will not unlink, must not
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
