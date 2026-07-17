// The note operations that reach past the editor: delete, restore, and empty.
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
// Renaming needs none of this: a note's filename follows its H1 now, and that
// happens inside the save controller's own flush loop, which is already
// serialised against writes (see syncTitle in notes/store.ts).
import {
  deleteNote as trashFile,
  deleteTrashed as unlinkTrashed,
  emptyTrash,
  listTrash,
  restoreNote as untrashFile,
} from "./channel";
import { forgetDoc, freezeDoc, retargetDoc } from "./store";
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
    dispatch({ type: "noteRestored", folder, note });
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
