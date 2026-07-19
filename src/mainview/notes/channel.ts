// The view end of the note-store RPC, mirroring terminal/channel.ts: the store
// and the editor pool call these, and main.tsx binds them to the Electroview RPC
// once it exists. Keeping the shim separate means the persistence logic
// (notes/store.ts) is testable without an RPC or a webview.
import type { BacklinkHit, ExternalOpenInfo, NoteMeta, TagHit, TrashMeta } from "../../shared/rpc-schema";
import type { NoteParams } from "../../shared/frontmatter";
import type { SearchHit } from "../../shared/search";
import type { TagInfo } from "../../shared/tags";

// What a read hands back: the note's text plus its disk version, which the
// store echoes into the next write's baseMtimeMs (external-edit guard).
// `locked` marks a locked note; `held: true` means the body was WITHHELD
// (vault locked — text is only the plaintext head, and the tab shows the
// placeholder face, never an editor); `damaged` rides on held when the
// ciphertext fails authentication (rpc-schema noteRead says the shape).
export interface NoteFile {
  text: string;
  mtimeMs: number;
  locked?: true;
  held?: true;
  damaged?: true;
}

// What a guarded write reports: the new disk version, and where an external
// edit went (the root's trash) when the save displaced one — null normally.
export interface WriteResult {
  mtimeMs: number;
  divergedTo: string | null;
}

interface NoteHandlers {
  // Scoped calls carry the workspace folder (an opaque root handle from Bun);
  // per-note calls carry just the path — its folder is derivable Bun-side.
  list: (folder: string) => Promise<NoteMeta[]>;
  read: (path: string) => Promise<NoteFile | null>;
  // The body scans carry lockedSkipped — how many locked notes the answer
  // deliberately does not cover (locking.md §4) — for the overlay and
  // panel footers.
  search: (folder: string, query: string) => Promise<{ hits: SearchHit[]; lockedSkipped: number }>;
  backlinks: (path: string) => Promise<{ backlinks: BacklinkHit[]; lockedSkipped: number }>;
  tags: (folder: string) => Promise<{ tags: TagInfo[]; lockedSkipped: number }>;
  tagged: (folder: string, tag: string) => Promise<{ hits: TagHit[]; lockedSkipped: number }>;
  write: (path: string, text: string, baseMtimeMs: number | null) => Promise<WriteResult>;
  create: (folder: string, text: string) => Promise<NoteMeta>;
  retitle: (path: string, text: string) => Promise<NoteMeta>;
  remove: (path: string) => Promise<string | null>;
  trash: (folder: string) => Promise<TrashMeta[]>;
  restore: (path: string) => Promise<NoteMeta>;
  removeTrashed: (path: string) => Promise<boolean>;
  empty: (folder: string) => Promise<number>;
  // Fire-and-forget, not a Promise: the store sends params on the save path
  // and nothing there can act on an acknowledgement.
  configureSession: (sessionId: string, params: NoteParams, notePath: string | null) => void;
  // Consume any CLI open request pending from before launch (`ledge <title>`
  // with the app closed). Called once at boot, AFTER the openExternal
  // subscription is up — the pull exists because a push at boot could fire
  // before anyone listens.
  takeOpenRequest: () => Promise<ExternalOpenInfo | null>;
  // Create-or-open today's daily note (rpc dailyOpen). `folder` is the
  // selected workspace — the fallback when the daily.workspace setting does
  // not pin one. The ExternalOpenInfo comes back for the caller to feed to
  // dispatchExternalOpen: the CLI-open subscriber owns select-then-open.
  openDaily: (folder: string) => Promise<{ open: ExternalOpenInfo; created: boolean }>;
  // Instantiate a template note — a PATH from the live note lists, the
  // picker's concrete pick — into a new note in `folder` (rpc
  // noteFromTemplate). Title null creates it as "Untitled".
  createFromTemplate: (folder: string, templatePath: string, title: string | null) => Promise<NoteMeta>;
}

let handlers: NoteHandlers | null = null;

export function configureNotes(h: NoteHandlers): void {
  handlers = h;
}

function bridge(): NoteHandlers {
  if (!handlers) throw new Error("note bridge not configured");
  return handlers;
}

export function listNotes(folder: string): Promise<NoteMeta[]> {
  return bridge().list(folder);
}

export function readNote(path: string): Promise<NoteFile | null> {
  return bridge().read(path);
}

// Full-text hits for `query` within one workspace's notes, newest note first
// (shared/search.ts owns the grammar and the caps). Bun does the scanning —
// the view never holds the corpus, only the result list. lockedSkipped rides
// along for the overlay's footer: locked notes are never searched.
export function searchNotes(folder: string, query: string): Promise<{ hits: SearchHit[]; lockedSkipped: number }> {
  return bridge().search(folder, query);
}

// The notes whose [[wikilinks]] point at this note, for the Backlinks panel.
// Bun scans (the same searchNotes stance: the view never holds the corpus)
// and resolves titles within the note's own workspace, the same way the
// linking notes' editors do.
export function backlinksOf(path: string): Promise<{ backlinks: BacklinkHit[]; lockedSkipped: number }> {
  return bridge().backlinks(path);
}

// One workspace's tag directory (frontmatter tags: + inline #hashtags,
// shared/tags.ts owns the grammar), alphabetical with per-note counts. Feeds
// the Tags panel, the overlay's tag rows, and the # completion vocabulary —
// Bun scans, the searchNotes stance again. Locked notes contribute exactly
// their plaintext head's tags; lockedSkipped counts their unscanned bodies.
export function listTags(folder: string): Promise<{ tags: TagInfo[]; lockedSkipped: number }> {
  return bridge().tags(folder);
}

// Every occurrence of one tag across a workspace, newest note first, rows
// carrying line/context/raw for the same list-open-reveal as backlinks.
export function notesTagged(folder: string, tag: string): Promise<{ hits: TagHit[]; lockedSkipped: number }> {
  return bridge().tagged(folder, tag);
}

// `baseMtimeMs` is the disk version this note last read or wrote (null before
// the first read lands): Bun refuses to silently overwrite a file that moved
// past it — see noteWrite in the rpc schema for the arbitration.
export function writeNote(path: string, text: string, baseMtimeMs: number | null): Promise<WriteResult> {
  return bridge().write(path, text, baseMtimeMs);
}

export function createNote(folder: string, text: string): Promise<NoteMeta> {
  return bridge().create(folder, text);
}

// Ask Bun to move a note's file to match its heading. Takes the note's text, not
// a name: Bun derives the slug, so it cannot be handed a path.
export function retitleNote(path: string, text: string): Promise<NoteMeta> {
  return bridge().retitle(path, text);
}

// Resolves to where the note landed in the trash (the handle Undo restores
// from), or null if the file was already gone.
export function deleteNote(path: string): Promise<string | null> {
  return bridge().remove(path);
}

export function listTrash(folder: string): Promise<TrashMeta[]> {
  return bridge().trash(folder);
}

// Takes a path Bun handed out via listTrash, and Bun re-checks that it really is
// a trashed note before moving it.
export function restoreNote(path: string): Promise<NoteMeta> {
  return bridge().restore(path);
}

// Unlink one trashed note for good. Same deal as restore: the path came from
// listTrash, and Bun re-checks it really is a trashed note before unlinking.
// Resolves false if it was already gone.
export function deleteTrashed(path: string): Promise<boolean> {
  return bridge().removeTrashed(path);
}

export function emptyTrash(folder: string): Promise<number> {
  return bridge().empty(folder);
}

// Hand Bun a note's spawn params (parsed from its frontmatter), keyed by the
// tab's docId — the same key its shells live under. It rides the note-store
// channel rather than the terminal one because the sender is notes/store.ts:
// the save path is the one place that sees every text change.
export function configureSession(sessionId: string, params: NoteParams, notePath: string | null): void {
  bridge().configureSession(sessionId, params, notePath);
}

// --- external changes --------------------------------------------------------
// Bun's watcher push (`notesChanged` in the rpc schema): one workspace root's
// files moved behind the app's back. main.tsx feeds the message in; App
// subscribes and answers with a folder refresh plus a reload of clean open
// buffers. A subscriber set rather than a Handlers field: this is a push the
// view REACTS to, not a capability it calls, and it can arrive before (or
// without) configureNotes in tests.

const changeSubs = new Set<(root: string) => void>();

export function onNotesChanged(fn: (root: string) => void): () => void {
  changeSubs.add(fn);
  return () => changeSubs.delete(fn);
}

export function dispatchNotesChanged(root: string): void {
  for (const fn of changeSubs) fn(root);
}

// --- external open requests --------------------------------------------------
// `ledge <title>` with the app already running (rpc openExternal): Bun has
// resolved the title, guarded the path, and read the meta; the view's whole
// job is to select the workspace and open the tab. Same subscriber shape as
// notesChanged, and for the same reason: a push the view reacts to.

const openSubs = new Set<(open: ExternalOpenInfo) => void>();

export function onExternalOpen(fn: (open: ExternalOpenInfo) => void): () => void {
  openSubs.add(fn);
  return () => openSubs.delete(fn);
}

export function dispatchExternalOpen(open: ExternalOpenInfo): void {
  for (const fn of openSubs) fn(open);
}

export function takeOpenRequest(): Promise<ExternalOpenInfo | null> {
  return bridge().takeOpenRequest();
}

// Create-or-open today's daily note. The caller (commands/glue.ts) feeds the
// returned open through dispatchExternalOpen so the CLI-open subscriber does
// the select-workspace-then-open — one definition, not a parallel path.
export function openDailyNote(folder: string): Promise<{ open: ExternalOpenInfo; created: boolean }> {
  return bridge().openDaily(folder);
}

// A new note from a template note (addressed by its path — the ⌥⌘N picker
// picked a concrete row), landing in `folder`.
export function createNoteFromTemplate(folder: string, templatePath: string, title: string | null): Promise<NoteMeta> {
  return bridge().createFromTemplate(folder, templatePath, title);
}

export type { BacklinkHit, ExternalOpenInfo, NoteMeta, TagHit, TrashMeta, SearchHit };
