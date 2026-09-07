// The note operations that reach past the editor: delete, restore, empty, and
// move.
//
// Delete has to keep the autosave controller and the filesystem in step. A
// note autosaves while its editor is open. The naive version ("ask Bun, then
// update the state") has a hole: an edit can land while Bun is moving the
// file, and that save writes the deleted note back. So freezeDoc suspends
// saving first, synchronously, before anything awaits:
//
//   freeze  -> the note stops writing, but keeps collecting edits
//   disk    -> Bun moves the file into its workspace folder's .ledge-trash
//   settle  -> forget the note entirely, or unfreeze it if the delete failed
//
// Retitling needs none of this: a note's filename follows its H1, and that
// rename runs inside the save controller's own flush loop, already serialised
// against writes (syncTitle in notes/store.ts). moveNoteTo, renameFolderTo and
// deleteFolderTo below rename from outside that loop, so they freeze too.
import {
  deleteFolder as deleteFolderFile,
  deleteNote as trashFile,
  deleteTrashed as unlinkTrashed,
  emptyTrash,
  listTrash,
  moveNote as moveFile,
  renameFolder as renameFolderFile,
  restoreNote as untrashFile,
  type NoteMeta,
} from "./channel";
import { forgetDoc, freezeDoc, retargetDoc } from "./store";
import { folderRenamed } from "./expansion";
import type { Action } from "@/workspace/store";

// Re-read one workspace folder's trash. Every mutation below ends with a
// re-read rather than patching the list in place: Bun owns the folder, the
// list is small, and a count that drifts from what the folder holds is worse
// than the round-trip.
export function refreshTrash(folder: string, dispatch: (action: Action) => void): Promise<void> {
  return listTrash(folder)
    .then((items) => dispatch({ type: "trashLoaded", folder, items }))
    .catch((err) => console.error("[notes] could not read the trash", err));
}

export interface DeleteResult {
  // Where the note landed, for Undo to restore from. Null if it was already
  // gone or the delete failed.
  trashed: string | null;
  error: string | null;
}

export async function deleteNote(
  path: string,
  folder: string,
  docIds: string[],
  dispatch: (action: Action) => void,
): Promise<DeleteResult> {
  for (const id of docIds) freezeDoc(id);
  let trashed: string | null;
  try {
    trashed = await trashFile(path);
  } catch (err) {
    for (const id of docIds) retargetDoc(id, path); // the note is still there
    console.error("[notes] delete failed", err);
    return { trashed: null, error: err instanceof Error ? err.message : String(err) };
  }
  // Only after trashFile resolved: the file is in the trash, so the pending
  // text has nowhere to go and is dropped rather than flushed. forgetDoc
  // leaves nothing for the editor teardown (releaseDoc) to write, so closing
  // the tabs cannot recreate the note.
  for (const id of docIds) forgetDoc(id);
  dispatch({ type: "noteDeleted", path });
  void refreshTrash(folder, dispatch);
  return { trashed, error: null };
}

// Bring a note back, for the Trash section's Restore and for Undo: one
// operation for both, so Undo is a shortcut rather than a second mechanism.
// Nothing is frozen first, because no save can race the move. The note has no
// tabs (noteDeleted closed them) and no save controller entry (forgetDoc
// dropped it).
export async function restoreNote(
  path: string,
  folder: string,
  dispatch: (action: Action) => void,
): Promise<string | null> {
  try {
    const note = await untrashFile(path);
    dispatch({ type: "noteAppeared", folder, note });
  } catch (err) {
    console.error("[notes] restore failed", err);
    return err instanceof Error ? err.message : String(err);
  }
  void refreshTrash(folder, dispatch);
  return null;
}

// Unlink one trashed note. The caller confirms first, so by the time this runs
// the note really is going. Nothing is frozen, for the same reason restore
// needs no freeze: a trashed note has no tabs and no save controller entry.
export async function deleteTrashedNote(
  path: string,
  folder: string,
  dispatch: (action: Action) => void,
): Promise<string | null> {
  try {
    await unlinkTrashed(path);
  } catch (err) {
    console.error("[notes] permanent delete failed", err);
    void refreshTrash(folder, dispatch); // it may have gone before it threw
    return err instanceof Error ? err.message : String(err);
  }
  void refreshTrash(folder, dispatch);
  return null;
}

// Unlink every trashed note in one workspace's trash. The caller confirms
// first, so by the time this runs the notes really are going.
export async function emptyTrashNow(
  folder: string,
  dispatch: (action: Action) => void,
): Promise<string | null> {
  try {
    await emptyTrash(folder);
  } catch (err) {
    console.error("[notes] empty trash failed", err);
    void refreshTrash(folder, dispatch); // some may have gone before it threw
    return err instanceof Error ? err.message : String(err);
  }
  dispatch({ type: "trashLoaded", folder, items: [] });
  return null;
}

// Move a note into another folder of its own workspace. The sidebar's Move to
// Folder…, its drag-and-drop, and New Folder's follow-up all land here.
//
// Freezes for the reason the file header gives. An edit landing mid-move
// would write to the old path, leaving a copy of the note in the folder it
// just left. retargetDoc then aims the waiting edit at the new path on
// success and at the old one on failure.
//
// `docIds` is every open tab on the note (a note can be open in more than one
// pane). Resolves to the note where it landed, for the caller to reveal.
export async function moveNoteTo(
  path: string,
  subfolder: string | null,
  docIds: string[],
  dispatch: (action: Action) => void,
): Promise<{ note: NoteMeta | null; error: string | null }> {
  for (const id of docIds) freezeDoc(id);
  let note: NoteMeta;
  try {
    note = await moveFile(path, subfolder);
  } catch (err) {
    for (const id of docIds) retargetDoc(id, path); // it did not move
    console.error("[notes] move failed", err);
    return { note: null, error: err instanceof Error ? err.message : String(err) };
  }
  for (const id of docIds) retargetDoc(id, note.path);
  // noteRenamed is the same action a retitle fires: the note's file moved, and
  // the tabs holding the old path follow it. The docId is untouched, so the
  // editor, its undo history and the note's shells carry through the move.
  dispatch({ type: "noteRenamed", path, note });
  return { note, error: null };
}

// Rename one folder of the selected workspace. The sidebar's inline field on a
// folder row is the only entry point.
//
// Freezes every note under the folder, for moveNoteTo's reason: any of them
// may be autosaving in a pane. Bun renames the whole directory, so an edit
// landing mid-rename would write to the old path and recreate the old folder
// around that one file. retargetDoc then aims each waiting edit at the new
// path on success and at the old one on failure.
//
// `openDocs` is every open tab on every note under the folder, keyed by the
// path the caller knows it by (a note can be open in more than one pane). The
// caller builds it from the store, before anything awaits.
export async function renameFolderTo(
  root: string,
  folder: string,
  name: string,
  openDocs: ReadonlyMap<string, readonly string[]>,
  dispatch: (action: Action) => void,
): Promise<{ folder: string | null; error: string | null }> {
  for (const ids of openDocs.values()) for (const id of ids) freezeDoc(id);
  let renamed: { folder: string; moved: Array<{ from: string; note: NoteMeta }> };
  try {
    renamed = await renameFolderFile(root, folder, name);
  } catch (err) {
    for (const [path, ids] of openDocs) for (const id of ids) retargetDoc(id, path); // nothing moved
    console.error("[notes] folder rename failed", err);
    return { folder: null, error: err instanceof Error ? err.message : String(err) };
  }
  // folderRenamed runs before the dispatches below, and the order matters: the
  // open-folder set is keyed by folder path, so the render that first shows a
  // note at `work/beta.md` must already agree that `work` is open. A set
  // published after them collapses the tree for a frame, and it springs back.
  folderRenamed(root, folder, renamed.folder);
  for (const { from, note } of renamed.moved) {
    for (const id of openDocs.get(from) ?? []) retargetDoc(id, note.path);
    // noteRenamed once per note, the same action a retitle and a move fire:
    // the note's file moved, and the tabs holding the old path follow it.
    // Every docId is untouched, so a folder rename costs no more session state
    // than renaming one note does: every open editor, its undo history and its
    // shells carry through.
    dispatch({ type: "noteRenamed", path: from, note });
  }
  // Every tab the answer did not name is unfrozen at the path it already had.
  // Bun's moved list comes from its own walk, so a tab on a note the view had
  // and that walk did not would otherwise stay frozen for the rest of the
  // session, collecting edits it never writes. The old path is the only one
  // this call has for that note.
  for (const [path, ids] of openDocs) {
    if (renamed.moved.some((m) => m.from === path)) continue;
    for (const id of ids) retargetDoc(id, path);
  }
  return { folder: renamed.folder, error: null };
}

export interface FolderDeleteResult {
  // Every note that went, old path beside where it landed. Undo restores from
  // these. Empty on a refusal, and also when the folder held nothing the walk
  // could still see.
  trashed: Array<{ from: string; to: string }>;
  error: string | null;
}

// Delete a folder. It freezes the way renameFolderTo does and ends the way
// deleteNote does.
//
// Every note under the folder is about to be in the trash, and any of them may
// be autosaving in a pane. Frozen, that edit waits. The answer then says which
// notes went. Each of those docs is forgotten rather than retargeted, since
// its file is in the trash and the pending text is dropped rather than
// flushed. forgetDoc leaves nothing for the editor teardown (releaseDoc) to
// write, so closing the tabs cannot recreate a note that was just deleted.
//
// `openDocs` is every open tab on every note under the folder, keyed by the
// path the caller knows it by, built from the store before anything awaits.
export async function deleteFolderTo(
  root: string,
  folder: string,
  openDocs: ReadonlyMap<string, readonly string[]>,
  dispatch: (action: Action) => void,
): Promise<FolderDeleteResult> {
  for (const ids of openDocs.values()) for (const id of ids) freezeDoc(id);
  let deleted: { trashed: Array<{ from: string; to: string }> };
  try {
    deleted = await deleteFolderFile(root, folder);
  } catch (err) {
    for (const [path, ids] of openDocs) for (const id of ids) retargetDoc(id, path); // nothing moved
    console.error("[notes] folder delete failed", err);
    return { trashed: [], error: err instanceof Error ? err.message : String(err) };
  }
  const gone = new Set(deleted.trashed.map((t) => t.from));
  for (const path of gone) {
    for (const id of openDocs.get(path) ?? []) forgetDoc(id);
    // noteDeleted once per note, the same action a single delete fires: the
    // tabs on it close and the note leaves the list.
    dispatch({ type: "noteDeleted", path });
  }
  // Every tab the answer did not name is unfrozen at the path it already had,
  // for renameFolderTo's reason. Bun deletes the notes its own walk found, so
  // a tab on a note the view had and that walk did not (ignored since, gone
  // from disk) would otherwise stay frozen for the rest of the session,
  // collecting edits it never writes. The old path is the only one this call
  // has for that note, and unlike the deleted ones that file is still there.
  for (const [path, ids] of openDocs) {
    if (gone.has(path)) continue;
    for (const id of ids) retargetDoc(id, path);
  }
  void refreshTrash(root, dispatch);
  return { trashed: deleted.trashed, error: null };
}
