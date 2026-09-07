// The label says which folder a note sits in. Flat rows draw it: quick-open,
// full-text search, backlinks, the tag drill-in. A sidebar row omits it: it
// already sits inside the folder's disclosure. Folders let two notes share a
// title, because titles are unique per folder, not per workspace. Wikilinks
// still resolve by title. A row with only the title cannot name the note.
import { cn } from "@/lib/utils";
import type { NoteMeta } from "../../shared/rpc-schema";

/** Maps note path to folder, for rows that carry a path but no folder. A
 * search hit is one (shared/search.ts). The backlinks and tags panels look up
 * the same way, though their hits extend NoteMeta and already carry a folder.
 * The view looks the folder up rather than parsing the path: Bun puts it on
 * each NoteMeta, and the caller already has the note list. */
export function folderIndex(notes: readonly NoteMeta[]): Map<string, string> {
  return new Map(notes.filter((n) => n.folder).map((n) => [n.path, n.folder!]));
}

// Every note in a folder gets the label, not only one whose title collides.
// A collision test would tie a row's shape to other notes' titles, so a note
// would gain and lose its label as unrelated notes were renamed. The folder
// is also useful to read on a row whose title collides with nothing. Nothing
// is drawn for a note at the top level, which is most of them.
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
