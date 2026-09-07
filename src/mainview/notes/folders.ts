// The note browser's shape: one flat list of rows for a tree of folders.
//
// Folders are derived from the notes, never listed separately. A folder
// exists because a note is in it. An attached project shows no row for `src/`,
// `dist/` or any other directory holding no note, and this list cannot
// disagree with the note list it came from. The browser cannot show an empty
// folder, so New Folder creates a note in the folder it makes
// (commands/registry.ts).
//
// The list is flat rather than nested because it is keyboard-navigable
// (interactions.md R5): ↑/↓ walk rows by index, and a nested render would have
// to flatten itself anyway. Depth is a number the row indents by, and a
// collapsed folder stops emitting its subtree.
import { folderContains } from "../../shared/folders";
import type { NoteMeta } from "../../shared/rpc-schema";

/** A note's folder as the browser reads it: "" at the top level, never
 * undefined, so callers stay branch-free (notesOf's total-selector rule). */
export function folderOf(note: NoteMeta): string {
  return note.folder ?? "";
}

/** The segments of a folder path, or [] for the root. */
export function segmentsOf(folder: string): string[] {
  return folder === "" ? [] : folder.split("/");
}

/** The last segment of a folder path. The browser draws it as the folder
 * row's label (NoteBrowser.tsx). */
export function nameOf(folder: string): string {
  const parts = segmentsOf(folder);
  return parts[parts.length - 1] ?? "";
}

/** The folder holding this one, "" when it sits at the top level. */
export function parentOf(folder: string): string {
  const cut = folder.lastIndexOf("/");
  return cut < 0 ? "" : folder.slice(0, cut);
}

/**
 * Every folder the browser knows about, sorted: each folder holding a note,
 * plus every ancestor of one. A note at `a/b/c.md` with nothing directly in
 * `a/` still needs an `a` row for `a/b` to sit under. Without it, `b` would be
 * drawn at the top level, as if the note were not in `a`.
 */
export function folderList(notes: readonly NoteMeta[]): string[] {
  const out = new Set<string>();
  for (const note of notes) {
    const parts = segmentsOf(folderOf(note));
    for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** How many notes sit at or below a folder. A collapsed row shows the count
 * of what it is hiding (NoteBrowser.tsx). */
export function countIn(notes: readonly NoteMeta[], folder: string): number {
  return notes.filter((n) => folderContains(folder, folderOf(n))).length;
}

export type BrowserRow =
  | { kind: "folder"; id: string; folder: string; name: string; depth: number; count: number; expanded: boolean }
  | { kind: "note"; id: string; note: NoteMeta; depth: number };

/**
 * The rows to draw, in order: at every level the folders come first
 * (alphabetically), then that level's own notes in `order`. A folder not in
 * `expanded` emits its row and stops, hiding its notes and subfolders.
 *
 * `order` is the browser's chosen note sort (by title, or by path in the
 * manual). It applies within a folder, not across the whole list: a global
 * sort would move a note's row into another folder's group.
 *
 * A folder row's id is prefixed so it cannot collide with a note's, whose id
 * is its absolute path. The id is a row's identity in the list: two rows
 * sharing one would take the roving tabindex together (lib/useListNav.ts
 * rowProps), and the focus restore after a rename would land on whichever
 * came first (NoteBrowser.tsx).
 */
export function browserRows(
  notes: readonly NoteMeta[],
  expanded: ReadonlySet<string>,
  order: (a: NoteMeta, b: NoteMeta) => number,
): BrowserRow[] {
  const folders = folderList(notes);
  const rows: BrowserRow[] = [];
  const emit = (folder: string, depth: number): void => {
    for (const child of folders.filter((f) => parentOf(f) === folder && f !== "")) {
      const open = expanded.has(child);
      rows.push({
        kind: "folder",
        id: folderRowId(child),
        folder: child,
        name: nameOf(child),
        depth,
        count: countIn(notes, child),
        expanded: open,
      });
      if (open) emit(child, depth + 1);
    }
    for (const note of notes.filter((n) => folderOf(n) === folder).sort(order)) {
      rows.push({ kind: "note", id: note.path, note, depth });
    }
  };
  emit("", 0);
  return rows;
}

/**
 * The Favorites section's rows: every note marked `favorite: true`, in the
 * same order the tree sorts by, all at depth 0.
 *
 * A separate list rather than a sort that lifts those notes to the top. The
 * tree says where a note lives, and hoisting a row out of its folder's group
 * would make it say something false. So a favorite note has two rows, and the
 * ids differ (favoriteRowId): one id on two rows would take the roving
 * tabindex together, the collision browserRows' own ids avoid.
 */
export function favoriteRows(
  notes: readonly NoteMeta[],
  order: (a: NoteMeta, b: NoteMeta) => number,
): Extract<BrowserRow, { kind: "note" }>[] {
  return notes
    .filter((n) => n.favorite)
    .sort(order)
    .map((note) => ({ kind: "note", id: favoriteRowId(note.path), note, depth: 0 }));
}

/** A favorites row's list id. Prefixed for folderRowId's reason, against the
 * note's own row in the tree below. */
export function favoriteRowId(path: string): string {
  return `fav:${path}`;
}

/** A folder row's list id. Prefixed because note ids are absolute paths. */
export function folderRowId(folder: string): string {
  return `dir:${folder}`;
}

/**
 * The open set after a folder is closed: the folder and everything under it
 * come out, so reopening it does not spill a subtree closed long ago.
 * `folderContains` decides "under it" (shared/folders.ts). The agent surfaces
 * scope folders with the same function, because the sibling-prefix trap (`a`
 * must not close `ab`) is the same trap on both ends.
 */
export function expandedWithout(expanded: ReadonlySet<string>, folder: string): Set<string> {
  return new Set([...expanded].filter((f) => !folderContains(folder, f)));
}

/**
 * The open set after a folder is renamed: the folder and everything under it
 * answer to their new path. Nothing opens or closes, since a rename changes
 * only what a folder is called. `folderContains` decides "under it" here too,
 * but not its root case: the workspace itself has no name to change, so `from`
 * is always a folder with a row. A `from` of "" would rewrite every open
 * folder.
 */
export function expandedRenamed(expanded: ReadonlySet<string>, from: string, to: string): Set<string> {
  if (from === "") return new Set(expanded);
  return new Set([...expanded].map((f) => (folderContains(from, f) ? `${to}${f.slice(from.length)}` : f)));
}

/** The open set after a folder is opened, with its ancestors too: opening a
 * folder whose ancestor is closed would reveal nothing. Move to Folder… and
 * New Note in Folder both reach this (notes/expansion.ts expandFolder), so the
 * note they just filed is on screen where it landed. */
export function expandedWith(expanded: ReadonlySet<string>, folder: string): Set<string> {
  const next = new Set(expanded);
  const parts = segmentsOf(folder);
  for (let i = 1; i <= parts.length; i += 1) next.add(parts.slice(0, i).join("/"));
  return next;
}
