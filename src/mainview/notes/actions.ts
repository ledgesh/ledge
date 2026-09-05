// The note operations that reach past the editor: delete, restore, empty, and
// move.
//
// Delete is the one that needs the autosave controller and the filesystem to
// move in step.
//
// The naive version ("ask Bun, then update the state") has a hole: a note is
// autosaving as you work on it, so an edit can land in the gap while Bun is moving
// the file. That save would bring the note you just deleted straight back.
//
// So saving is suspended first, synchronously, before anything awaits:
//
//   freeze  -> the note stops writing, but keeps collecting edits
//   disk    -> Bun moves the file into its workspace folder's .ledge-trash
//   settle  -> forget the note entirely, or unfreeze it if the delete failed
//
// RETITLING needs none of this: a note's filename follows its H1, and that
// happens inside the save controller's own flush loop, which is already
// serialised against writes (see syncTitle in notes/store.ts). MOVING is a
// rename from outside that loop, so it dances too (moveNoteTo, at the bottom).
import {
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

// Re-read one workspace folder's trash. Every mutation below ends with one
// rather than patching the list in place: Bun owns the folder, the list is
// small, and a count that drifts from the folder is worse than a round-trip.
export function refreshTrash(folder: string, dispatch: (action: Action) => void): Promise<void> {
  return listTrash(folder)
    .then((items) => dispatch({ type: "trashLoaded", folder, items }))
    .catch((err) => console.error("[notes] could not read the trash", err));
}

export interface DeleteResult {
  // Where the note landed, for Undo to restore from. Null if it was already gone
  // or the delete failed.
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
  // Only now: the file is in the trash, so the pending text has nowhere to go and
  // must be dropped rather than flushed. forgetDoc leaves nothing for the editor
  // teardown (releaseDoc) to write, so closing the tabs cannot resurrect the note.
  for (const id of docIds) forgetDoc(id);
  dispatch({ type: "noteDeleted", path });
  void refreshTrash(folder, dispatch);
  return { trashed, error: null };
}

// Bring a note back, from the Trash section's Restore or from Undo: the same
// operation either way, which is what lets Undo be a shortcut rather than a
// second mechanism with its own bugs.
//
// No freeze dance here. The note has no tabs (noteDeleted closed them) and no
// save controller entry (forgetDoc dropped it), so there is nothing to race:
// it is a file being moved while nothing in the app is holding it.
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

// Unlink one trashed note. The caller confirms first; by the time this runs,
// the note really is going.
//
// No freeze dance, for the same reason restore needs none: a trashed note has
// no tabs and no save controller entry, so nothing in the app is holding it.
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
// first; by the time this runs, the notes really are going.
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

// Move a note into another folder of its own workspace: the sidebar's Move to
// Folder…, its drag-and-drop, and New Folder's follow-up all land here.
//
// Delete's freeze dance, for delete's reason. A note being moved from the
// sidebar may be autosaving in a pane at the same time, and this rename does
// NOT run inside the save controller's flush loop the way retitling does
// (notes/store.ts syncTitle) — so an edit landing mid-move would write to the
// old path and leave a copy of the note behind in the folder it just left.
// Frozen, the edit waits; retargetDoc then aims it at wherever the note ended
// up, which is the new path on success and the old one on failure.
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
  // The same action a retitle fires: a note's file moved, and the tabs holding
  // the old path follow it. The docId is untouched, so the editor, its undo
  // history and the note's shells carry through the move.
  dispatch({ type: "noteRenamed", path, note });
  return { note, error: null };
}

// Rename one folder of the selected workspace. The sidebar's inline field on a
// folder row is the only door.
//
// moveNoteTo's freeze dance, N notes wide and for the same reason: every note
// under the folder is about to be at a new path, and any of them may be
// autosaving in a pane right now. An edit landing mid-rename would write to the
// old path — which, since Bun moved the whole DIRECTORY, means recreating the
// old folder around one resurrected file. Frozen, the edit waits; retargetDoc
// then aims it at wherever its note ended up, which is the new path on success
// and the old one on failure.
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
  // BEFORE the dispatches, and that order is the whole of it: the open set is
  // keyed by folder path, so the render that first shows a note at
  // `work/beta.md` must already agree that `work` is open. Publish it
  // afterwards and the tree collapses for a frame and springs back.
  folderRenamed(root, folder, renamed.folder);
  for (const { from, note } of renamed.moved) {
    for (const id of openDocs.get(from) ?? []) retargetDoc(id, note.path);
    // One per note, the same action a retitle and a move fire: a note's file
    // moved and the tabs holding the old path follow it. Every docId is
    // untouched, so every open editor, its undo history and its shells carry
    // through — a folder rename costs no more session state than renaming one
    // note does.
    dispatch({ type: "noteRenamed", path: from, note });
  }
  // Every tab the answer did not name is unfrozen where it was. Bun lists the
  // notes it moved from its own walk, so a tab on a note the view had and that
  // walk did not would otherwise stay FROZEN for the rest of the session,
  // collecting edits it never writes. Aimed at the old path, which is the
  // honest answer: this call was told nothing about it.
  for (const [path, ids] of openDocs) {
    if (renamed.moved.some((m) => m.from === path)) continue;
    for (const id of ids) retargetDoc(id, path);
  }
  return { folder: renamed.folder, error: null };
}
