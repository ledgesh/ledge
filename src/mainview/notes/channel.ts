// The view end of the note-store RPC, mirroring terminal/channel.ts. The store
// and the editor pool call these functions. boot.tsx binds them once the view
// is connected to a server, and harness.tsx binds test doubles. Keeping the
// shim separate keeps the persistence logic (notes/store.ts) testable without
// an RPC or a webview.
import type { BacklinkHit, ExternalOpenInfo, NoteMeta, TagHit, TrashMeta } from "../../shared/rpc-schema";
import type { NoteParams } from "../../shared/frontmatter";
import type { SearchHit } from "../../shared/search";
import type { TagInfo } from "../../shared/tags";

// A read hands back the note's text and its disk version, which the store
// echoes into the next write's baseMtimeMs (external-edit guard). `locked`
// marks a locked note. `held: true` means the body was withheld: the vault is
// locked, or the body would not open. `text` is then the plaintext head alone,
// and the tab shows the placeholder, never an editor. `damaged` rides on held
// when the ciphertext fails authentication (rpc-schema noteRead has the shape).
export interface NoteFile {
  text: string;
  mtimeMs: number;
  locked?: true;
  held?: true;
  damaged?: true;
}

// What a folder rename reports: where the folder is now, and every note that
// travelled with it. `from` is the path the view's tabs and note list still
// hold. `note` is the same note where it now lives.
export interface FolderRenamed {
  folder: string;
  moved: Array<{ from: string; note: NoteMeta }>;
}

// What a folder delete reports: every note that went to the trash. `from` is
// the path the view's tabs and note list still hold, `to` where it landed, the
// handle Undo restores it from. Deleting one note returns that same handle on
// its own (bun/notes.ts deleteNote). Notes the walk did not see are not in
// here and were not touched.
export interface FolderDeleted {
  trashed: Array<{ from: string; to: string }>;
}

// What a guarded write reports: the new disk version, and where an external
// edit went (the root's trash) when the save displaced one. Null normally.
export interface WriteResult {
  mtimeMs: number;
  divergedTo: string | null;
}

interface NoteHandlers {
  // Scoped calls carry the workspace folder, an opaque root handle from Bun.
  // Per-note calls carry just the path, since Bun derives its folder.
  list: (folder: string) => Promise<NoteMeta[]>;
  read: (path: string) => Promise<NoteFile | null>;
  // The body scans carry lockedSkipped: how many locked notes the answer does
  // not cover (locking.md §4). The overlay and the panel footers show it.
  search: (folder: string, query: string, scope: string) => Promise<{ hits: SearchHit[]; lockedSkipped: number }>;
  backlinks: (path: string) => Promise<{ backlinks: BacklinkHit[]; lockedSkipped: number }>;
  tags: (folder: string, scope: string) => Promise<{ tags: TagInfo[]; lockedSkipped: number }>;
  tagged: (folder: string, tag: string) => Promise<{ hits: TagHit[]; lockedSkipped: number }>;
  write: (path: string, text: string, baseMtimeMs: number | null) => Promise<WriteResult>;
  // Park a buffer's text in the note's trash without writing the note itself
  // (rpc noteStash). The stranded-edit path calls it and nothing else does.
  stash: (path: string, text: string) => Promise<string>;
  // `subfolder` is where inside the workspace the note goes (root-relative,
  // "" or null for the root itself). It is the only name the view chooses,
  // and Bun guards it. It is not called `folder` because `folder` means the
  // workspace root everywhere in this file, and a call site must not confuse
  // the two.
  create: (folder: string, text: string, subfolder?: string | null) => Promise<NoteMeta>;
  retitle: (path: string, text: string) => Promise<NoteMeta>;
  // Move a note into another folder of its own workspace (rpc noteMove).
  move: (path: string, subfolder: string | null) => Promise<NoteMeta>;
  // Add or remove the note's `favorite: true` frontmatter line (rpc
  // noteFavorite). One line of the file changes, so an open buffer picks the
  // edit up the way it picks up any external one (editorPool
  // reloadOpenNotes).
  favorite: (path: string, on: boolean) => Promise<NoteMeta>;
  // Rename one folder of a workspace, in place (rpc folderRename). `name` is
  // one segment, never a path. Resolves to the folder's new root-relative
  // path and to every note that travelled: old path beside new meta.
  renameFolder: (folder: string, subfolder: string, name: string) => Promise<FolderRenamed>;
  // Delete one folder of a workspace by deleting the notes in it (rpc
  // folderDelete). Resolves to every note that went to the trash.
  deleteFolder: (folder: string, subfolder: string) => Promise<FolderDeleted>;
  remove: (path: string) => Promise<string | null>;
  trash: (folder: string) => Promise<TrashMeta[]>;
  restore: (path: string) => Promise<NoteMeta>;
  removeTrashed: (path: string) => Promise<boolean>;
  empty: (folder: string) => Promise<number>;
  // Fire-and-forget, not a Promise: the store sends params on the save path
  // and nothing there can act on an acknowledgement.
  configureSession: (sessionId: string, params: NoteParams, notePath: string | null) => void;
  // Consume any CLI open request pending from before launch (`ledge <title>`
  // with the app closed). Called once at boot, after the openExternal
  // subscription is up. The pull exists because a push at boot could fire
  // before anyone listens.
  takeOpenRequest: () => Promise<ExternalOpenInfo | null>;
  // Create-or-open today's daily note (rpc dailyOpen). `folder` is the
  // selected workspace, the fallback when the daily.workspace setting does not
  // resolve to exactly one registered root. The ExternalOpenInfo comes back
  // for the caller to feed to dispatchExternalOpen: the CLI-open subscriber
  // owns select-then-open.
  openDaily: (folder: string) => Promise<{ open: ExternalOpenInfo; created: boolean }>;
  // Instantiate a template note into a new note in `folder` (rpc
  // noteFromTemplate). `templatePath` is a path from the live note lists, the
  // picker's concrete pick. Title null creates it as "Untitled".
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
// (shared/search.ts owns the grammar and the caps). Bun scans, so the view
// holds the result list and never the corpus. lockedSkipped feeds the
// overlay's footer: locked notes are never searched. `scope` narrows to one
// folder of that workspace and the folders inside it, "" to the whole
// workspace. Bun narrows before the scan, so the hit cap is not spent on
// notes the caller has already said it does not want.
export function searchNotes(folder: string, query: string, scope = ""): Promise<{ hits: SearchHit[]; lockedSkipped: number }> {
  return bridge().search(folder, query, scope);
}

// The notes whose [[wikilinks]] point at this note, for the Backlinks panel.
// Bun scans (the same searchNotes stance: the view never holds the corpus)
// and resolves titles within the note's own workspace, the same way the
// linking notes' editors do.
export function backlinksOf(path: string): Promise<{ backlinks: BacklinkHit[]; lockedSkipped: number }> {
  return bridge().backlinks(path);
}

// One workspace's tag directory (frontmatter tags: + inline #hashtags,
// shared/tags.ts owns the grammar), alphabetical with per-note counts. Bun
// scans, as it does for searchNotes. It feeds the Tags panel, the overlay's
// tag rows, and the # completion vocabulary. Locked notes contribute only
// their plaintext head's tags, and lockedSkipped counts their unscanned
// bodies. `scope` narrows to one folder, as searchNotes' does.
export function listTags(folder: string, scope = ""): Promise<{ tags: TagInfo[]; lockedSkipped: number }> {
  return bridge().tags(folder, scope);
}

// Every occurrence of one tag across a workspace, newest note first, rows
// carrying line/context/raw for the same list-open-reveal as backlinks.
export function notesTagged(folder: string, tag: string): Promise<{ hits: TagHit[]; lockedSkipped: number }> {
  return bridge().tagged(folder, tag);
}

// `baseMtimeMs` is the disk version this note last read or wrote, null before
// the first read lands. Bun refuses to silently overwrite a file that moved
// past it (noteWrite in the rpc schema states the arbitration).
export function writeNote(path: string, text: string, baseMtimeMs: number | null): Promise<WriteResult> {
  return bridge().write(path, text, baseMtimeMs);
}

// Put text somewhere recoverable that is not this note: the root's trash,
// under the note's own name (rpc noteStash). For a buffer typed here while the
// server was unreachable, whose note the server has changed since. That
// buffer is somebody's writing, not the note. It is parked before the editor
// shows the note's real text (workspace/editorPool.ts resolveStrandedNotes).
export function stashNote(path: string, text: string): Promise<string> {
  return bridge().stash(path, text);
}

export function createNote(folder: string, text: string, subfolder?: string | null): Promise<NoteMeta> {
  return bridge().create(folder, text, subfolder);
}

// Move a note into another folder of the workspace it is already in (rpc
// noteMove). The destination is a root-relative folder the user picked, null
// for the workspace's top level; the note keeps its name, its docId, and the
// editor and shell hanging off that docId.
export function moveNote(path: string, subfolder: string | null): Promise<NoteMeta> {
  return bridge().move(path, subfolder);
}

// Rename a folder of the selected workspace, keeping it where it sits (rpc
// folderRename). `name` is the folder's new name, not a path: the rename does
// not move it, so nothing under it changes depth and no note's body is read or
// rewritten. That is why this works on a folder holding locked notes with the
// vault shut, where moving one note is refused.
export function renameFolder(folder: string, subfolder: string, name: string): Promise<FolderRenamed> {
  return bridge().renameFolder(folder, subfolder, name);
}

// Delete a folder of the selected workspace (rpc folderDelete): every note in
// it, at any depth, moved into the trash exactly as deleting one note is. The
// folder then stops being listed because nothing is in it, and the emptied
// directories are removed. A directory still holding something the note list
// never showed keeps its folder.
export function deleteFolder(folder: string, subfolder: string): Promise<FolderDeleted> {
  return bridge().deleteFolder(folder, subfolder);
}

// Ask Bun to move a note's file to match its heading. Takes the note's text, not
// a name: Bun derives the slug, so it cannot be handed a path.
export function retitleNote(path: string, text: string): Promise<NoteMeta> {
  return bridge().retitle(path, text);
}

// Mark or unmark a note as a favorite. Resolves to the note as the marker
// leaves it, so the caller can tell a no-op from a change.
export function favoriteNote(path: string, on: boolean): Promise<NoteMeta> {
  return bridge().favorite(path, on);
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
// tab's docId, the same key its shells live under. It rides the note-store
// channel rather than the terminal one because the sender is notes/store.ts:
// the save path is the one place that sees every text change.
export function configureSession(sessionId: string, params: NoteParams, notePath: string | null): void {
  bridge().configureSession(sessionId, params, notePath);
}

// --- external changes --------------------------------------------------------
// Bun's watcher push (`notesChanged` in the rpc schema): one workspace root's
// files moved behind the app's back. boot.tsx feeds the message in. App
// subscribes and answers with a folder refresh plus a reload of clean open
// buffers. A subscriber set rather than a Handlers field: the view reacts to
// this push rather than calling it, and it can arrive before or without
// configureNotes in tests.

const changeSubs = new Set<(root: string) => void>();

export function onNotesChanged(fn: (root: string) => void): () => void {
  changeSubs.add(fn);
  return () => changeSubs.delete(fn);
}

export function dispatchNotesChanged(root: string): void {
  for (const fn of changeSubs) fn(root);
}

// --- the wire coming back ----------------------------------------------------
// Raised by this end about its own connection (wire.ts CLIENT_PUSHES), unlike
// everything above, and boot.tsx feeds it in. It lives here because a dropped
// wire loses exactly what `notesChanged` covers. A push with nowhere to go is
// dropped rather than queued (bun/daemon.ts, remote.md §7), so nothing tells
// the view about the roots that moved while the wire was down: another
// device's save, a git checkout, an agent working in a drawer. The lists and
// every open buffer go on showing what was true when the wire went. Window
// focus is a second net on a Mac, and it misses the cases that matter most:
// the window never left, or there is no window focus to have (ios.md §5).

// One sink, replaced not stacked, like the drawer's (terminal/channel.ts):
// App owns the folder list and the open tabs and is the only thing that can
// answer. The tags and backlinks panels need no relink subscription of their
// own. They re-fetch when the store's note list for their folder changes,
// which is what the refresh produces.
let relinkSink: (() => void) | null = null;

export function onNotesRelink(sink: () => void): () => void {
  relinkSink = sink;
  return () => {
    if (relinkSink === sink) relinkSink = null;
  };
}

export function dispatchNotesRelink(): void {
  relinkSink?.();
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
// returned open through dispatchExternalOpen, so the CLI-open subscriber does
// the select-workspace-then-open.
export function openDailyNote(folder: string): Promise<{ open: ExternalOpenInfo; created: boolean }> {
  return bridge().openDaily(folder);
}

// A new note from a template note, landing in `folder`. The template is
// addressed by path because the ⌥⌘N picker picked a concrete row.
export function createNoteFromTemplate(folder: string, templatePath: string, title: string | null): Promise<NoteMeta> {
  return bridge().createFromTemplate(folder, templatePath, title);
}

export type { BacklinkHit, ExternalOpenInfo, NoteMeta, TagHit, TrashMeta, SearchHit };
