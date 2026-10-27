// How the note browser sorts its notes, per workspace: by title (the default)
// or by last modified, newest first.
//
// A module-level mirror for notes/expansion.ts's reasons. The commands that
// switch it (commands/registry.ts note.sortByModified, note.sortByTitle) read
// it to decide which face is live, and the layout save subscribes to it
// (App.tsx). `.layout.json` carries each workspace's choice beside its open
// folders (workspace/persist.ts). Which order the list is in is arrangement,
// like which folders are open.
//
// The docs workspace has no choice to make: notes/folders.ts noteOrder keeps
// it in path order whatever this says.
import { useSyncExternalStore } from "react";

export type NoteSort = "title" | "modified";

// Keyed by workspace root. Absent means the default, so a workspace never
// switched writes nothing to the layout file.
const chosen = new Map<string, NoteSort>();
const subs = new Set<() => void>();

/** One workspace's sort. Always an answer, never undefined. */
export function sortIn(root: string): NoteSort {
  return chosen.get(root) ?? "title";
}

export function setSort(root: string, sort: NoteSort): void {
  if (sortIn(root) === sort) return;
  if (sort === "title") chosen.delete(root);
  else chosen.set(root, sort);
  for (const fn of subs) fn();
}

/** The sort one workspace's saved layout restored (workspace/persist.ts), at
 * boot or when Undo brings a removed workspace back. Anything but a known non-default value is the
 * default, since the file is machine-written and may predate the field. */
export function seedSort(root: string, raw: unknown): void {
  if (raw === "modified") chosen.set(root, raw);
  else chosen.delete(root);
  for (const fn of subs) fn();
}

/** Listen for any workspace's sort changing. The layout save subscribes too
 * (App.tsx), for expansion.ts subscribeExpansion's reason. */
export function subscribeSort(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** The React face of the same state (the browser's rows). */
export function useNoteSort(root: string): NoteSort {
  return useSyncExternalStore(subscribeSort, () => sortIn(root));
}

/** Tests only: back to a fresh app. */
export function resetSort(): void {
  chosen.clear();
}
