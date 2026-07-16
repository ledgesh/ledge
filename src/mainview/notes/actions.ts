// Delete: the one note operation that needs the autosave controller and the
// filesystem to move in step.
//
// The naive version ("ask Bun, then update the state") has a hole: a note is
// autosaving as you work on it, so an edit can land in the gap while Bun is moving
// the file. That save would bring the note you just deleted straight back.
//
// So saving is suspended first, synchronously, before anything awaits:
//
//   freeze  -> the note stops writing, but keeps collecting edits
//   disk    -> Bun moves the file to ~/.ledge/.trash
//   settle  -> forget the note entirely, or unfreeze it if the delete failed
//
// Renaming needs none of this: a note's filename follows its H1 now, and that
// happens inside the save controller's own flush loop, which is already
// serialised against writes (see syncTitle in notes/store.ts).
import { deleteNote as trashFile } from "./channel";
import { forgetDoc, freezeDoc, retargetDoc } from "./store";
import type { Action } from "@/workspace/store";

export async function deleteNote(
  path: string,
  docIds: string[],
  dispatch: (action: Action) => void,
): Promise<string | null> {
  for (const id of docIds) freezeDoc(id);
  try {
    await trashFile(path);
  } catch (err) {
    for (const id of docIds) retargetDoc(id, path); // the note is still there
    console.error("[notes] delete failed", err);
    return err instanceof Error ? err.message : String(err);
  }
  // Only now: the file is in the trash, so the pending text has nowhere to go and
  // must be dropped rather than flushed. forgetDoc leaves nothing for the editor
  // teardown (releaseDoc) to write, so closing the tabs cannot resurrect the note.
  for (const id of docIds) forgetDoc(id);
  dispatch({ type: "noteDeleted", path });
  return null;
}
