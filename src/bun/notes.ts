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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { ASSETS_DIRNAME, type BacklinkHit, type NoteMeta, type TagHit, type TrashMeta } from "../shared/rpc-schema";
import { headingOf, labelOf, slugOf, titleOf } from "../shared/slug";
import { parseFrontmatter } from "../shared/frontmatter";
import { collectHits, type SearchHit } from "../shared/search";
import { resolveWikiTitle, wikiRefsOf } from "../shared/wikilinks";
import { normalizeTag, tagDirectoryOf, tagRefsOf, type TagInfo } from "../shared/tags";
import { loadIgnore } from "./ignore";
import { assertRegisteredRoot, assertWritableRoot, isInside, kindOf, rootContaining, uniqueName } from "./workspaces";
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
import { folderNameProblem, folderScopeOf, notesUnder } from "../shared/folders";

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
// The template flag comes from the same text the title does: the head already in
// hand is enough frontmatter to answer `template:`, so the picker's registry
// costs no extra read. The marker's value rides along (`true`, or the `daily`
// role); present-only-when-marked keeps every ordinary meta lean.
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
    ...(p.locked !== null ? { locked: true as const } : {}),
  };
}

// The same, for a note whose text we do not already have in hand: read just
// enough of the file to label and flag it. The locked flag rides the same
// head read the title does (the plaintext head is DESIGNED to fit it,
// locking.md §2), so the sidebar glyph and the scans' skip both come
// from the listing they already had.
async function metaAt(path: string, root?: string): Promise<NoteMeta> {
  const head = await headAt(path);
  const p = head === null ? null : parseFrontmatter(head).params;
  // The folder rides the meta because every surface that lists notes flatly —
  // quick-open, full-text search, backlinks, the agents' listings — has to be
  // able to say WHICH of two same-titled notes a row is (folders made that
  // possible, so folders have to answer it). Derived, never stored: `root` is
  // passed by listNotes, which has it, and looked up otherwise. Omitted at the
  // top level, so the many notes that live there say nothing at all.
  const r = root ?? rootContaining(path);
  const folder = r ? folderOf(r, path) : "";
  return {
    path,
    title: labelOf(head === null ? null : headingOf(head), path),
    mtimeMs: (await stat(path)).mtimeMs,
    ...(folder === "" ? {} : { folder }),
    ...(p?.template ? { template: p.template } : {}),
    ...(p !== null && p.locked !== null ? { locked: true as const } : {}),
  };
}

// Enough of a note to read its first line and its frontmatter block. Notes are
// small, but a note carrying a big pasted blob is not worth reading whole just
// to label it, and listNotes does this once per note on every refresh.
const HEAD_BYTES = 4096;
async function headAt(path: string): Promise<string | null> {
  try {
    // A first line (or frontmatter block) longer than this would be truncated
    // here, but a heading that long is not a usable label (slugify caps at 60),
    // and a >4KB block is somebody's art project (the glue.ts noteHead edge).
    return await Bun.file(path).slice(0, HEAD_BYTES).text();
  } catch {
    return null; // unreadable: fall back to the filename
  }
}

// --- filesystem ------------------------------------------------------------

// A note path from the view must be a .md file inside a registered root. The
// extension check is load-bearing, not tidiness: even with settings.jsonc now
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

// The path segments of `p` below `dir`, or null when `p` is not VISIBLY inside
// it: outside, the directory itself, or holding a dot-segment anywhere below
// `dir`. Dot-entries are the app's invisible files (.ledge-trash, .ledge-assets,
// a project's .git), and the rule that keeps a guard and the listing it guards
// agreeing about which files exist — what listNotes and trashFiles hide, no
// path-taking call may accept.
function visibleSegmentsUnder(dir: string, p: string): string[] | null {
  const d = resolve(dir);
  const t = resolve(p);
  if (!isInside(d, t) || t === d) return null;
  const parts = t.slice(d.length + 1).split(sep);
  return parts.some((part) => part === "" || part.startsWith(".")) ? null : parts;
}

// A note's FOLDER: where inside its workspace it sits, as a root-relative path
// with forward slashes ("projects/api"), or "" at the top level. Placement, not
// identity — a note is still addressed by title (shared/wikilinks.ts) and still
// keyed by docId while it is open (architecture.md §4). This is only ever the
// answer to "which directory", and it is derived from the path rather than
// stored, so it cannot go stale.
export function folderOf(root: string, path: string): string {
  const rel = relative(resolve(root), dirname(resolve(path)));
  return rel === "" ? "" : rel.split(sep).join("/");
}

/**
 * Resolve a caller-supplied folder against its root, or throw.
 *
 * This is the SECOND name that may cross the trust boundary, and the first one
 * a caller chooses. Filenames never needed validating: `slugOf` builds them out
 * of the note's own heading and emits only [a-z0-9-], so there was no name to
 * check and no way for the view to ask for a path (baseFor above). A folder is
 * different — it has to match what is already on disk, so it cannot be slugged
 * into safety, and it arrives from the view, from MCP, and from the CLI.
 *
 * The rules are assetPathOf's, for the same reason: relative only (a leading
 * slash is an absolute path, and silently reinterpreting one as root-relative
 * is how a guard becomes a suggestion), no backslashes, no `.` or `..` segment,
 * no dot-entry, and inside the root once resolved. All but the last are shape,
 * and shape is `folderNameProblem` in shared/folders.ts — the settings
 * validator has to ask the same question about `daily.folder` with no root in
 * reach, and this gate composes its message from that answer so the two can
 * never come to disagree about what a folder may be called. Containment stays
 * here, because it is the only part that needs a root.
 *
 * Empty (or absent) means the root itself, which is where every note lived
 * before folders and where one still lands when nobody says otherwise.
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
 * The ignore check is not a safety rule — bun/ignore.ts is about VISIBILITY —
 * but creating a note somewhere listNotes will never show it is a silent
 * disappearance, and the caller asking for `node_modules` has almost certainly
 * not meant it. Refusing names the reason, which is the only way the user can
 * act on it (`.ledgeignore` takes a `!` line).
 */
export async function ensureFolder(root: string, folder: string | null | undefined): Promise<string> {
  const r = assertWritableRoot(assertRegisteredRoot(root));
  await rootReady(r);
  const dir = folderPathOf(r, folder);
  if (dir !== r) {
    // Every ANCESTOR, not just the leaf: listNotes prunes a directory whole and
    // never visits its children, so `node_modules/mine` is invisible because of
    // its parent and a leaf-only check would wave it through.
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
      else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(await metaAt(path, r));
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
// Locked notes are SKIPPED — always, vault state irrelevant (locking.md
// §4): the scans feed overlays and agents alike, and an answer that changed
// with vault state would leak by inconsistency. The count rides back so every
// surface can say "N locked notes not searched" where the answer would have
// been; titles still match in quick-open, which reads metas, not bodies.
export async function searchNotes(
  root: string,
  query: string,
  folder: string = "",
): Promise<{ hits: SearchHit[]; lockedSkipped: number }> {
  // The scope narrows the METAS, before collectHits reads a byte: the cap is
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
export async function backlinksTo(path: string): Promise<{ backlinks: BacklinkHit[]; lockedSkipped: number }> {
  const root = assertNote(path);
  const target = resolve(path);
  const metas = await listNotes(root);
  const out: BacklinkHit[] = [];
  let lockedSkipped = 0;
  for (const meta of metas) {
    if (meta.path === target) continue; // a note is not "linked from" itself
    // A locked note's links point OUT from a body this scan must not read
    // (searchNotes' skip, same rule); links TO a locked note still resolve —
    // the target's title is plaintext, and it is other notes' bodies that
    // carry them.
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

// One workspace's tag directory — the ONE tag scan, shared by the Tags
// panel (rpc tagList), the overlay's tag rows, the # completion vocabulary,
// and the MCP `tags` tool, so agents and the UI can never disagree about
// what tags exist. Built on listNotes for searchNotes' reason (listed and
// tagged cannot drift apart), reading whole bodies because inline #hashtags
// live there — the accepted backlinksTo cost, scan-on-demand with no index.
// Grammar, aggregation, and ordering all live in shared/tags.ts; a note
// deleted mid-scan costs that note only.
// A locked note's BODY hashtags are unscannable (searchNotes' skip), but its
// frontmatter `tags:` line lives in the plaintext head where the user chose
// to put it (locking.md §6) — so locked notes contribute exactly their
// head's tags, and still count toward lockedSkipped: the body went unread.
async function tagSourceOf(meta: NoteMeta): Promise<string | null> {
  if (!meta.locked) return (await readNote(meta.path))?.text ?? null;
  return headAt(meta.path);
}

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

// Every occurrence of one tag across a workspace, newest note first (the
// Tags panel's drill-in, rpc tagNotes; also the MCP `tags` tool's second
// mode). Same walk as tagsIn, filtered to one case-folded identity; rows
// carry line/context/raw exactly as backlinksTo's do, and for the same
// reveal. The empty tag is refused rather than answered: it would "match"
// nothing meaningfully, and a blank query reaching this deep is a caller bug
// worth surfacing.
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

// What readNote hands back. For an ordinary note, text and disk version. A
// LOCKED note (locking.md) carries the flag; `held: true` means the body
// was withheld — the vault is locked — and `text` is only the plaintext head,
// which the caller may label with but must not present as the note. `damaged`
// rides on held when the body exists but fails authentication (tampered
// outside Ledge) or its header cannot open: withheld is the honest shape for
// both — degrade, never surface ciphertext or wrong plaintext.
export interface NoteFile {
  text: string;
  mtimeMs: number;
  locked?: true;
  held?: true;
  damaged?: true;
}

// Read a note, or null if it is gone (deleted behind our back, say). The mtime
// comes back too: it is the note's disk version, which the view echoes into
// writeNote's baseMtimeMs so a save can tell its own last state from an
// external edit. Stat BEFORE read, deliberately: if a write lands between the
// two, the text is newer than the mtime we report, so the next comparison
// still sees a difference and re-reads — stale-looking, never stale-passing.
//
// A locked note decrypts here — and ONLY here — when the vault is unlocked:
// every app-side content path funnels through this seam. The scans never ask
// (they filter on the meta's locked flag first; the skip is deliberate and
// vault-state-independent), and the agent surfaces refuse before reading
// (mcpTools locate), so "unlocked" never leaks anywhere the lock is FOR.
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

// What a save reports back: the written file's new disk version, and — when
// the guard below fired — where the overwritten external edit went.
export interface WriteResult {
  mtimeMs: number;
  divergedTo: string | null;
}

/**
 * The bytes a buffer becomes on disk at `path`, and the plaintext they stand for.
 *
 * What the DISK says governs lock state, not the buffer (locking.md §2): the
 * head read is what decides. A buffer cannot MINT a lock — a stray locked: line
 * (pasted from a locked file's text) is stripped, since honoring it would write
 * a "locked" note whose key nobody holds — and it cannot DROP one: a save whose
 * buffer lost the line still encrypts under the disk's header. Only lockNote and
 * removeLockNote change the state.
 *
 * Its own function because two callers write a buffer into this root, and the
 * second one (stashNote) is the one that would be easy to get wrong: a stash
 * that skipped the seal would be the only path in the app that puts a locked
 * note's body on disk in the clear.
 *
 * `outgoing` is what to write. `text` is the same content with the body still in
 * the clear, which is what a divergence comparison has to be made against —
 * sealing is nondeterministic, so a locked note's bytes never match twice.
 *
 * Sealing NEEDS the vault open, and sealBody throws when it is not. That throw
 * is load-bearing in both callers: it keeps the edit in the view's autosave
 * retry rather than writing plaintext. The placeholder face makes it
 * near-unreachable for a save, but an unlock that raced a relock must fail.
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
      // For a locked note the comparison is PLAINTEXT-equivalent, not byte
      // equality: sealing is nondeterministic (fresh nonce), so bytes always
      // differ. Decrypt the disk body; a body that will not open (tampered)
      // counts as different and takes the trash trip like any foreign write.
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

// Whether the disk says this note is locked — the head read is the whole
// answer (the flag lives in the plaintext frontmatter). The runBlock/paste
// prompt-fence refusal reads this (bun/index.ts): cheap enough to ask per
// run, and fresh enough that a just-locked note refuses immediately.
export async function isNoteLocked(path: string): Promise<boolean> {
  assertNote(path);
  const head = await headAt(path);
  return head !== null && parseFrontmatter(head).params.locked !== null;
}

// The probe an unlock falls back to when no vault file exists (synced-in
// locked notes, locking.md §3): any locked note's self-contained
// header. First hit wins; scanning label-reads only.
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
      // an unlistable root costs itself, the boot fetch's stance
    }
  }
  return undefined;
}

// The in-root image references a note's text carries (`![](…)`) — the set
// the lock sweep seals and Remove Lock unseals. Resolution reuses the asset
// guard, against the note's OWN folder: a ref that fails it (a remote URL, a
// traversal out of the root, a non-image) is simply not an asset and not
// swept.
//
// Both halves come back because the two sweeps below need different ones. The
// ref is what a person reads in the shared-image notice. The PATH is
// identity, and it has to be: references are note-relative (assets.ts), so
// two notes in different folders write different strings for the same file —
// `.ledge-assets/x.png` from the root and `../.ledge-assets/x.png` from a
// subfolder. A sweep that compared reference strings would see no sharing
// note, and Remove Lock would unseal an image a locked note still shows.
// Keying the map by path also collapses two references to one file into one
// seal, which the old ref-keyed Set could not.
const IMAGE_REF = /(!\[[^\]]*\]\()([^()\s]+)(\))/g;
interface AssetRef {
  /** The reference as the note writes it, for the notice. */
  ref: string;
  /** The file it names, resolved: the only sound way to compare two notes. */
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
 * file changes what every one of them resolves to: `.ledge-assets/x.png` in a
 * note that moves into `trips/` would name a `trips/.ledge-assets` that does
 * not exist, and every picture in the note would break.
 *
 * Only references that RESOLVE from the old location are touched, and each is
 * re-emitted for the new one. A remote URL and a non-image are left exactly as
 * written, because neither is an asset. Whether the file is actually there is
 * not asked: a reference to an image not pasted yet should still travel with
 * the note rather than be quietly left aiming at the old folder.
 *
 * The trash needs none of this, and that is why deleteNote still just renames:
 * a delete and its restore change the depth by the same one segment in
 * opposite directions, so the string that is wrong while a note sits in
 * `.ledge-trash` is right again the moment it comes back, and nothing renders
 * a trashed note in between.
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

// Lock a note: mint its header (random data key wrapped by the master key,
// salt copied in), stamp the line, seal the body — and SWEEP its images
// (locking.md §5): every in-root image the note references is sealed in
// place under its own name, master-key wrapped, so the screenshot is as
// sealed as the prose around it. An image an UNLOCKED note also shows is
// sealed anyway and SURFACED, never silently decided and never refused: a
// hard refusal would deadlock the legitimate "lock both sharing notes" flow
// (each blocks on the other), while sealing merely extends the lock's own
// visibility rule to the shared image everywhere it appears — the other
// note's widget shows the locked face until an unlock, nothing breaks.
// `sealedShared` names what the user should hear about.
// Requires the vault unlocked (the RPC layer runs vault creation first on
// the very first lock). The template exclusivity is checked here, not only
// in the UI: a template's body exists to be stamped into new notes, the
// opposite of locked, and the MCP template path must not be reachable into
// one however the marker arrived.
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
      // Each note's refs resolved against ITS folder, then intersected on the
      // file. Comparing the strings would answer "no" for the same image in
      // two folders, and the sweep would seal it without saying so.
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

// Remove a note's lock: decrypt, strip the line, write plaintext — and
// reverse the image sweep for every referenced asset no OTHER locked note
// still shows (their claim keeps it sealed; this note's widget shows the
// sealed placeholder while the vault is closed, which is exactly true). The
// one sanctioned decrypt-to-disk, command-only by design (a text edit cannot
// do this — writeNote above re-stamps).
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
    // Claims are collected as resolved PATHS, never as reference strings: a
    // locked note one folder away writes the same image a different way, and
    // a string comparison would miss its claim and unseal an image it shows.
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
        // A damaged sealed image costs itself (stays sealed), never the
        // unlock of the note's own text.
        console.warn("[vault] could not unseal image during Remove Lock", r.ref, err);
      }
    }
  }
  await writeSealed(path, stripLockedLine(file.text), file.mtimeMs);
  return metaAt(path);
}

// Change the vault passphrase: new salt, new master key, and every locked
// note's HEADER plus every sealed image's key wrap rewritten across the given
// roots — headers and wraps only, never a body byte (the data keys are
// unchanged; that split is the whole reason per-note keys exist). Commit
// happens after the sweep, so a crash mid-sweep leaves a coherent old-pass
// vault with some headers already opening under the new one — both openable,
// nothing lost, and re-running finishes the job (rewrapHeader throws per
// already-moved item, which the loop reports and skips).
export async function changeVaultPassphrase(newPassphrase: string, rootsToScan: string[]): Promise<number> {
  const { oldKey, newKey, newSalt } = await beginPassphraseChange(newPassphrase);
  let rewrapped = 0;
  for (const root of rootsToScan) {
    let metas: NoteMeta[];
    try {
      metas = await listNotes(root);
    } catch {
      continue; // an unlistable root costs itself, the boot fetch's stance
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
    // listNotes' (dot-entries skipped) plus the app's own assets dir, which
    // is dotted precisely to be invisible to listings.
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
// .ledge-assets pool, plus non-dotted in-root images (any of which the lock
// sweep may have sealed — a note can reference `img/x.png`).
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

// The lock/unlock writes: temp-plus-rename with the divergence guard's
// SHAPE but none of its compare — these are whole-state transitions taken
// from a just-read version, so a foreign write since simply moves to the
// trash (rename-not-unlink, as everywhere).
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
export async function createNote(root: string, text: string, folder?: string | null): Promise<NoteMeta> {
  // ensureFolder carries the write guard (so the refusal names the act, "create
  // in the docs folder", before any name is allocated), the root's readiness,
  // and the folder guard. With no folder it is the root, which is where every
  // note landed before folders existed.
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

// Move a note into another folder of its OWN workspace, keeping its name.
//
// Within one root by construction, so this is a rename(2) like every other move
// in this file: atomic, and immune to EXDEV even when the workspace sits on
// another volume. Cross-workspace is not offered — a note's root decides its
// wikilink scope, its tag directory, its assets pool and its trash, so moving
// between roots is four migrations wearing a trench coat, not a rename.
//
// The docId is untouched, exactly as in retitleNote: the note's editor, undo
// history and running shell all survive the move, which is what makes it safe
// to move a note you are sitting in (architecture.md §4).
//
// A trashed note is refused rather than moved. Restore is the way out of the
// trash — it is the call that knows where the note came from — and letting a
// move double as an untrash would leave the note's origin folder recorded
// nowhere.
export async function moveNote(path: string, folder: string | null): Promise<NoteMeta> {
  const root = assertWritableRoot(assertNote(path));
  const from = resolve(path);
  if (isInside(trashDirOf(root), from)) {
    throw new Error("that note is in the trash — restore it first, then move it");
  }
  const dir = await ensureFolder(root, folder);
  if (dirname(from) === dir) return metaAt(from); // already there: the outcome asked for

  // Read BEFORE the rename, because the move has to rewrite the note's image
  // references for its new folder (rebaseAssetRefs) and a locked note whose
  // vault is shut cannot be read at all. Refusing here is the honest end of
  // that: the alternative is a note that arrives with its pictures pointing at
  // nothing and no way to tell it happened. Same "unlock first" grammar as
  // Remove Lock, and the vault is the only thing standing in the way.
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
  // uniqueName against the DESTINATION, because rename(2) clobbers silently
  // (architecture.md §3). The note keeps the name its heading gave it; only
  // when the destination already holds that name does it take a suffix.
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
    // writeNote should hold against a foreign edit — and writeNote re-seals a
    // locked note's body on the way out, which is why this hands it plaintext.
    const rebased = rebaseAssetRefs(file.text, root, from, target);
    if (rebased !== file.text) await writeNote(target, rebased, file.mtimeMs);
  } finally {
    reserved.delete(name);
  }
  return metaAt(target);
}

// Move a note's file to match its heading. Returns the note where it now lives,
// which may be the path it was already at: the caller asks for a title, not a
// filename, and this decides what that costs.
//
// The docId is untouched by design: the note's editor, undo history, and running
// shell all survive, which is the whole reason path and docId are separate keys.
// This is what makes naming-by-heading safe despite PLAN D15's warning.
export async function retitleNote(path: string, text: string): Promise<NoteMeta> {
  assertWritableRoot(assertNote(path));
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

// Where inside the trash a note's file goes: the trash MIRRORS the workspace's
// folder structure, so a note deleted from `projects/api` lands in
// `.ledge-trash/projects/api`. The note's own path is then the whole record of
// where it came from — no sidecar index to keep in step, nothing to prune, and
// an external tool poking at the folder sees the same thing Ledge does.
//
// A note inside a DOT-folder flattens to the trash's top level instead. Such a
// note is invisible to listNotes already, and burying it under an invisible
// trash folder would make it invisible to the Trash section too — unrecoverable
// from inside the app rather than merely unlisted. The failure leans toward
// keeping notes reachable, as it does everywhere else in this file.
function trashSubdirOf(root: string, path: string): string {
  const trashDir = trashDirOf(root);
  const segments = visibleSegmentsUnder(resolve(root), dirname(resolve(path)));
  return segments === null || segments.length === 0 ? trashDir : join(trashDir, ...segments);
}

// Delete a note by moving it aside rather than unlinking it. Same rename(2)
// primitive as a save, so it is atomic and cheap, and it means a misclick costs
// a trip to the Trash section rather than the note. The trash is the note's own
// root's — the delete never crosses a filesystem boundary.
//
// Returns where the note landed, so the caller can offer to undo it, or null if
// there was nothing to delete.
export async function deleteNote(path: string): Promise<string | null> {
  const root = assertWritableRoot(assertNote(path));
  const trashDir = trashDirOf(root);
  if (isInside(trashDir, path)) return null; // already trashed
  const destDir = trashSubdirOf(root, path);
  await mkdir(destDir, { recursive: true });
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
 * Park text in a root's trash without it ever having been a note.
 *
 * The case is a buffer typed while its server could not be reached, and
 * overtaken on the server since (remote.md §7). It is somebody's writing, it is
 * not what the note says any more, and there is nowhere on the live path for it
 * to go. deleteNote cannot take it: deleteNote moves a FILE, and this has never
 * been one.
 *
 * The trash rather than a new note, and named exactly as a delete names one,
 * because restoreNote already does the right thing with it. A restore lands
 * BESIDE the live note under a free name rather than over it, which is precisely
 * the affordance a stranded buffer needs: both versions on screen, and the merge
 * is the user's to make. Giving it a name of its own would buy a little clarity
 * in the Trash list and cost the Trash section a second kind of thing to
 * understand.
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
  // The note's own folder, mirrored, exactly as a delete records it: a restore
  // is supposed to land BESIDE the live note, and beside means in its folder.
  const destDir = trashSubdirOf(root, path);
  await mkdir(destDir, { recursive: true });
  const taken = new Set(await readdir(destDir));
  const dest = join(destDir, uniqueName(titleOf(path), taken));
  await writeFile(dest, outgoing, "utf8");
  return dest;
}

// --- trash ------------------------------------------------------------------

// Only .md files inside the root's trash count, at any depth — the trash mirrors
// the workspace's folders (trashSubdirOf), so a deleted note may sit several
// levels down. Anything else in there arrived by some route other than a delete
// and is left strictly alone: Empty removes exactly what the list showed, and
// nothing it did not.
//
// The walk is listNotes' walk, dot-entries and all, and that is load-bearing
// rather than tidy: assertTrashed accepts exactly what this yields, so the guard
// on the two unlink paths and the listing they act on cannot drift apart.
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
    const head = await headAt(path);
    out.push({ path, title: labelOf(head === null ? null : headingOf(head), path), deletedAt: s.ctimeMs });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

// A trashed note must be a .md file VISIBLY inside its root's trash, at any
// depth. Still stricter than the containment check live notes get, because
// restore and empty are the two calls that can move or unlink a file: bare
// containment would also accept the trash folder itself, and a dot-segment
// would accept a file no listing ever showed.
//
// This is what the trash's mirrored folders cost. It used to say DIRECTLY
// inside, which is a tighter sentence but the wrong one once a delete can put a
// note in `.ledge-trash/projects` — the guard would refuse to restore or empty
// exactly the notes the mirroring was for. What keeps it honest is that
// `visibleSegmentsUnder` is the same rule trashFiles walks by, so the guard
// accepts precisely the set the Trash section listed and nothing else.
// (testing.md §3 names this invariant; the test moved with it.)
//
// Returns the root whose trash holds the note.
function assertTrashed(path: string): string {
  const root = rootContaining(path);
  if (!root || visibleSegmentsUnder(trashDirOf(root), path) === null || !/\.md$/i.test(path)) {
    throw new Error(`not a trashed note: ${path}`);
  }
  return root;
}

// Move a note back out of the trash, into the FOLDER it was deleted from. Its
// old name may have been taken by a note created since, so the name is
// allocated fresh rather than assumed free: this is a rename(2) like any
// other, and rename(2) clobbers silently.
//
// The trash mirrors the workspace's folders, so the note's path inside the
// trash is the record of where it belongs and nothing else has to remember it.
// A folder emptied since the delete is recreated on the way back: the note
// asked for that folder by sitting in it, and landing it at the top level
// instead would quietly undo a filing decision.
//
// The trash's now-empty folder is left behind. Removing it would put an rmdir
// on a path whose whole job is to be reversible, for a directory no listing
// shows (trashFiles yields nothing for an empty one) — a cost with no reader.
export async function restoreNote(path: string): Promise<NoteMeta> {
  // Belt: no delete can put a note in the docs root's trash, but a restore
  // WRITES into its root, so the guard holds here too.
  const root = assertWritableRoot(assertTrashed(path));
  await rootReady(root);
  // Straight from the mirrored path, NOT through folderPathOf: this folder was
  // recorded by a delete rather than typed by a caller, assertTrashed has
  // already established it is visibly inside the trash, and re-validating a
  // name the app itself wrote would only add a way for a restore to fail.
  const rel = relative(trashDirOf(root), dirname(resolve(path)));
  const dir = rel === "" ? root : join(root, rel);
  await mkdir(dir, { recursive: true });
  const reserved = reservedIn(dir);
  const taken = new Set(await readdir(dir));
  for (const name of reserved) taken.add(name);
  // Reserved across the rename, like every other allocation into a directory
  // (createNote): this read the reserved set without ever joining it, so two
  // restores into one folder in the same tick could pick one name twice.
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
