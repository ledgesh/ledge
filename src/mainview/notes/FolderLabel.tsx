// Where a note lives, on a row that is not the tree.
//
// The sidebar answers "which folder" by POSITION — the row is inside the
// folder's disclosure. Every other list of notes is flat: quick-open,
// full-text search, backlinks, the tag drill-in. Once two notes may share a
// title (folders made that possible: titles are unique per folder, not per
// workspace, and wikilinks still resolve by title), a flat row that shows only
// the title cannot say which note it is.
//
// Shown ALWAYS for a note in a folder, not only where a title collides.
// Conditional disambiguation would make a row's shape depend on what OTHER
// notes are called, so the same note would gain and lose its label as
// unrelated notes were renamed — and the label is worth reading anyway.
// Nothing is drawn for a note at the top level, which is most of them.
import { cn } from "@/lib/utils";
import type { NoteMeta } from "../../shared/rpc-schema";

/** path → folder, for the surfaces whose rows are not NoteMetas (a search hit
 * carries a path and a title, not a placement). A lookup rather than path
 * arithmetic in the view: Bun derives the folder, and the note list already
 * has the answer. */
export function folderIndex(notes: readonly NoteMeta[]): Map<string, string> {
  return new Map(notes.filter((n) => n.folder).map((n) => [n.path, n.folder!]));
}

export function FolderLabel({ folder, className }: { folder: string | undefined; className?: string }) {
  if (!folder) return null;
  return (
    <span
      data-testid="note-folder"
      className={cn("shrink-0 truncate text-[11px] text-muted-foreground/70", className)}
      title={`in ${folder}`}
    >
      {folder}
    </span>
  );
}
