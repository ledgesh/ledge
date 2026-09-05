// The note browser's shape: one flat list of rows for a tree of folders.
//
// Folders are DERIVED from the notes, never listed separately. A folder is a
// folder because a note is in it — which is what keeps an attached project
// from showing `src/`, `dist/` and every other directory that holds no note as
// an empty row, and what means nothing here can disagree with the note list it
// came from. The cost is that an empty folder is not a thing the browser can
// show, and that is why New Folder creates a note in the folder it makes
// (commands/registry.ts): a folder with nothing in it would vanish.
//
// Flat rather than nested because the list is KEYBOARD-NAVIGABLE
// (interactions.md R5): ↑/↓ walk rows by index, and a nested render would have
// to flatten itself anyway to answer "which row is next". Depth is a number the
// row indents by, and a collapsed folder simply stops emitting its subtree.
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

/** The last segment — what a folder row is labelled with. */
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
 * plus every ANCESTOR of one. The ancestors matter because a note at
 * `a/b/c.md` with nothing in `a/` still needs an `a` row to hang `a/b` off —
 * a tree that skipped it would draw `b` at the top level and lie about where
 * the note is.
 */
export function folderList(notes: readonly NoteMeta[]): string[] {
  const out = new Set<string>();
  for (const note of notes) {
    const parts = segmentsOf(folderOf(note));
    for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** How many notes sit at or below a folder — what a collapsed row hides. */
export function countIn(notes: readonly NoteMeta[], folder: string): number {
  return notes.filter((n) => folderContains(folder, folderOf(n))).length;
}

export type BrowserRow =
  | { kind: "folder"; id: string; folder: string; name: string; depth: number; count: number; expanded: boolean }
  | { kind: "note"; id: string; note: NoteMeta; depth: number };

/**
 * The rows to draw, in order: at every level the folders come first
 * (alphabetically), then that level's own notes in `order`. A folder not in
 * `expanded` emits its row and stops — its notes and subfolders are what the
 * disclosure is hiding.
 *
 * `order` is the browser's chosen note sort (by title, or by path in the
 * manual), applied WITHIN a folder rather than across the whole list: sorting
 * a tree globally is the one thing that would make a note's row jump to
 * another folder's group.
 *
 * A folder row's id is prefixed so it cannot collide with a note's, whose id is
 * its absolute path — the ids are what useListNav moves focus between, and two
 * rows answering to one id is a focus that lands on the wrong one.
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

/** A folder row's list id. Prefixed because note ids are absolute paths. */
export function folderRowId(folder: string): string {
  return `dir:${folder}`;
}

/**
 * Closing a folder closes everything under it, so reopening it does not spill
 * a subtree you closed a while ago and had forgotten was open.
 *
 * `folderContains` is what decides "under it" — shared with the agent
 * surfaces' folder scoping, because the sibling-prefix trap (`a` must not
 * close `ab`) is the same trap on both ends.
 */
export function expandedWithout(expanded: ReadonlySet<string>, folder: string): Set<string> {
  return new Set([...expanded].filter((f) => !folderContains(folder, f)));
}

/** Opening a folder opens its ancestors too: a row you cannot see is not
 * revealed by opening it. What Move to Folder… and New Note in Folder both
 * call, so the note they just filed is on screen where it landed. */
export function expandedWith(expanded: ReadonlySet<string>, folder: string): Set<string> {
  const next = new Set(expanded);
  const parts = segmentsOf(folder);
  for (let i = 1; i <= parts.length; i += 1) next.add(parts.slice(0, i).join("/"));
  return next;
}
