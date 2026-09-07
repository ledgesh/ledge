// Which folders the note browser has open, per workspace.
//
// A module-level mirror rather than component `useState` (architecture.md §5).
// That section leaves state in a component only when nothing outside it
// reacts. Here more than the browser's rows react:
//
//   - Move to Folder… and a drag onto a folder row expand the destination
//     through NoteBrowser.tsx's `file`, not through the note.move command.
//   - New Note in Folder expands it from the command itself
//     (commands/registry.ts note.newInFolder).
//   - folder.toggle reads it to decide whether its menu item says Expand or
//     Collapse (commands/registry.ts).
//   - The layout save subscribes to it (App.tsx).
//
// vault/channel.ts is a module-level mirror for the same reason.
//
// Not in the reducer, and not persisted here. `.layout.json` carries each
// workspace's open folders beside its pane tree. workspace/persist.ts reads
// the live set out of here on its way to the file and seeds it on the way
// back, so a relaunch finds the tree as it was left. Which folders are open is
// arrangement, the same kind of fact as which tabs are. Nothing here knows
// there is a file.
//
// This is a view of a folder list that notes/folders.ts derives from the
// notes, so saving it is cheap: an entry naming a folder that no longer exists
// matches no row, and there is nothing to reconcile with the disk. Restore
// prunes those entries anyway, on the same authority that prunes a restored
// tab: the boot note list. A folder deleted from a shell while Ledge was
// closed does not sit in the file forever.
//
// This module has to be told about a rename made in the app (folderRenamed
// below). The folder is the same folder under a new name, so letting its entry
// stop matching would collapse a subtree nobody closed.
//
// Nothing tells it about a delete, and that is the same rule rather than an
// omission. The folder is gone, its entry matches no row, and the next restore
// prunes it. Leaving the entry is what brings the folder back open when Undo
// restores its notes.
import { useSyncExternalStore } from "react";
import { expandedRenamed, expandedWith, expandedWithout } from "./folders";

// Keyed by workspace root, so switching workspaces and switching back reopens
// the same folders. Two workspaces cannot share an answer for a folder name
// they happen to have in common.
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

/** Open a folder and its ancestors (folders.ts expandedWith). Every caller
 * wants the row revealed, and a row inside a closed folder is not on screen. */
export function expandFolder(root: string, folder: string): void {
  if (folder === "") return; // the top level is always shown; it has no row
  publish(root, expandedWith(expandedIn(root), folder));
}

/** Close a folder and everything under it, so reopening it does not show a
 * subtree that was closed a while ago. */
export function collapseFolder(root: string, folder: string): void {
  publish(root, expandedWithout(expandedIn(root), folder));
}

/** A folder was renamed: the rows under it are the same rows under new names,
 * so the open ones stay open (folders.ts expandedRenamed). The rename calls
 * this (notes/actions.ts); the set is never recomputed from the live folder
 * list. Without the call, the entries under the old name would match no row
 * and the subtree would collapse. */
export function folderRenamed(root: string, from: string, to: string): void {
  publish(root, expandedRenamed(expandedIn(root), from, to));
}

/** Boot only: the open folders one workspace's saved layout restored
 * (workspace/persist.ts). A set, not a merge: the file is the whole answer for
 * that root, and at boot there is nothing yet to merge it with. */
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
