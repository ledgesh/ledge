// Which folders the note browser has open, per workspace.
//
// A mirrored module rather than component `useState` (architecture.md §5),
// because more than the browser reacts to it: Move to Folder…, New Note in
// Folder and a drag onto a folder row all have to REVEAL where the note
// landed, and the folder.toggle command has to read the state to say whether
// its menu item is Expand or Collapse. State several commands act on is not
// ephemeral chrome, and vault/channel.ts is the same shape for the same
// reason.
//
// Deliberately not persisted and not in the reducer. It is a view of a folder
// list that is itself derived from the notes (notes/folders.ts): a workspace
// whose folders changed on disk has nothing here to reconcile, because an
// entry naming a folder that no longer exists simply never matches a row.
// The one thing that DOES have to be told is a rename made in the app
// (folderRenamed below) — there the folder is the same folder and only its
// name changed, so letting the entry stop matching would collapse a subtree
// nobody closed.
import { useSyncExternalStore } from "react";
import { expandedRenamed, expandedWith, expandedWithout } from "./folders";

// Keyed by workspace ROOT, so switching workspaces and switching back finds
// the tree the way it was left, and two workspaces cannot share an answer for
// the folder name they happen to have in common.
const open = new Map<string, ReadonlySet<string>>();
const subs = new Set<() => void>();
const EMPTY: ReadonlySet<string> = new Set();

function publish(root: string, next: ReadonlySet<string>): void {
  open.set(root, next);
  for (const fn of subs) fn();
}

/** The open folders of one workspace. Always a set, never undefined. */
export function expandedIn(root: string): ReadonlySet<string> {
  return open.get(root) ?? EMPTY;
}

export function isExpanded(root: string, folder: string): boolean {
  return expandedIn(root).has(folder);
}

/** Open a folder AND its ancestors — revealing a row inside a closed folder is
 * what every caller actually wants (folders.ts expandedWith). */
export function expandFolder(root: string, folder: string): void {
  if (folder === "") return; // the top level is always shown; it has no row
  publish(root, expandedWith(expandedIn(root), folder));
}

/** Close a folder and everything under it, so reopening it does not spill a
 * subtree you closed a while ago. */
export function collapseFolder(root: string, folder: string): void {
  publish(root, expandedWithout(expandedIn(root), folder));
}

/** A folder was renamed: the rows under it are the same rows under new names,
 * so the open ones stay open (folders.ts expandedRenamed). Called by the
 * rename itself rather than derived, because an entry naming a folder that no
 * longer exists never matches a row again — the tree would simply collapse. */
export function folderRenamed(root: string, from: string, to: string): void {
  publish(root, expandedRenamed(expandedIn(root), from, to));
}

export function toggleFolder(root: string, folder: string): void {
  if (isExpanded(root, folder)) collapseFolder(root, folder);
  else expandFolder(root, folder);
}

/** The React face of the same state (the browser's rows). */
export function useExpanded(root: string): ReadonlySet<string> {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => expandedIn(root),
  );
}

/** Tests only: back to a fresh app. */
export function resetExpansion(): void {
  open.clear();
}
