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
// Not in the reducer, and not persisted BY this module: `.layout.json` carries
// each workspace's open folders beside its pane tree, so a relaunch finds the
// tree the way it was left (workspace/persist.ts, which reads the live set out
// of here on its way to the file and seeds it on the way back). Which folders
// are open is arrangement, the same kind of fact as which tabs are, so it is
// kept in the same place. Nothing here knows there is a file.
//
// What holds either way is that this is a view of a folder list itself DERIVED
// from the notes (notes/folders.ts), and that is what makes saving it cheap:
// there is nothing to reconcile with the disk, because an entry naming a folder
// that no longer exists simply never matches a row. Restore prunes those
// entries anyway, on the same authority that prunes a restored tab — the boot
// note list — so a folder deleted from a shell while Ledge was closed does not
// sit in the file forever.
//
// The one thing that DOES have to be told is a rename made in the app
// (folderRenamed below) — there the folder is the same folder and only its
// name changed, so letting the entry stop matching would collapse a subtree
// nobody closed.
//
// A DELETE is told nothing, and that is the same rule rather than an omission:
// the folder is gone, so its entry matches no row, and the next restore prunes
// it. Leaving it is what makes Undo put the tree back the way it was — the
// folder returns already open, because nobody ever closed it.
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

/** Boot only: the open folders one workspace's saved layout restored
 * (workspace/persist.ts). A set, not a merge — the file is the whole answer
 * for that root, and at boot there is nothing yet to merge it with. */
export function seedExpansion(root: string, folders: Iterable<string>): void {
  publish(root, new Set(folders));
}

export function toggleFolder(root: string, folder: string): void {
  if (isExpanded(root, folder)) collapseFolder(root, folder);
  else expandFolder(root, folder);
}

/** Listen for any change to any workspace's open folders. Exported rather than
 * inlined into the hook below because the browser's rows are no longer the only
 * listener: the layout save subscribes too (App.tsx), since opening a folder
 * changes what is on screen without changing AppState. */
export function subscribeExpansion(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** The React face of the same state (the browser's rows). */
export function useExpanded(root: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribeExpansion, () => expandedIn(root));
}

/** Tests only: back to a fresh app. */
export function resetExpansion(): void {
  open.clear();
}
