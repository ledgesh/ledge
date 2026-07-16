// The note list: every .md in ~/.ledge, sitting under the workspace strip in the
// sidebar. Notes are global to the notes root, so this list is the same whichever
// workspace is selected; what changes per workspace is which of them are open.
//
// There is no rename here on purpose: a note's filename follows its first-line H1
// (notes/store.ts), so you rename a note by retitling it in the editor, and this
// list shows the slug that produced.
import { FileText, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ContextMenu, MenuItem } from "@/components/ContextMenu";
import { docIdsForPath, openNotePaths, useWorkspace } from "@/workspace/store";
import { focusedTab } from "@/workspace/tree";
import { deleteNote } from "./actions";
import type { NoteMeta } from "./channel";

export function NoteBrowser() {
  const { state, dispatch, selected } = useWorkspace();
  // Where the right-click menu sits, keyed by path (the note's identity).
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  // A failed delete, shown under the list rather than thrown away into the console.
  const [error, setError] = useState<string | null>(null);

  // Sorted by title, NOT by the mtime order the store holds them in: an autosave
  // rewrites mtime on every keystroke burst, so an mtime-sorted list would shuffle
  // itself under the pointer while you type.
  const notes = useMemo(
    () => [...state.notes].sort((a, b) => a.title.localeCompare(b.title)),
    [state.notes],
  );
  const open = useMemo(() => openNotePaths(state), [state]);
  const current = focusedTab(selected)?.path ?? null;

  const trash = (note: NoteMeta) => {
    setError(null);
    void deleteNote(note.path, docIdsForPath(state, note.path), dispatch).then(setError);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline gap-1.5 px-3 pb-1 pt-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Notes
        </span>
        <span className="text-[10px] text-muted-foreground/70">{notes.length || ""}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {notes.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            No notes yet. A new note is saved to ~/.ledge as soon as you type in it.
          </p>
        ) : (
          notes.map((note) => (
            <NoteRow
              key={note.path}
              note={note}
              current={note.path === current}
              open={open.has(note.path)}
              onOpen={() => dispatch({ type: "openNote", note })}
              onContextMenu={(x, y) => setMenu({ path: note.path, x, y })}
            />
          ))
        )}
      </div>

      {error && (
        <p className="border-t px-3 py-1.5 text-[11px] leading-snug text-destructive">{error}</p>
      )}

      <button
        className="flex items-center gap-2 border-t px-3.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => dispatch({ type: "newTab" })}
      >
        <Plus className="size-4" /> New Note
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            destructive
            // Deliberately not "Move to Trash": that promises the Finder Trash,
            // with Put Back and a Dock icon, and this is an app-private folder.
            // The tooltip is where the note actually went.
            title="Kept in ~/.ledge/.trash"
            onSelect={() => {
              const note = state.notes.find((n) => n.path === menu.path);
              if (note) trash(note);
              setMenu(null);
            }}
          >
            <Trash2 className="size-3.5" /> Delete
          </MenuItem>
        </ContextMenu>
      )}
    </div>
  );
}

// `current` is the note in the focused pane's active tab; `open` is any note with
// a tab somewhere. Clicking either way goes through openNote, which focuses the
// existing tab rather than opening the file a second time.
function NoteRow({
  note,
  current,
  open,
  onOpen,
  onContextMenu,
}: {
  note: NoteMeta;
  current: boolean;
  open: boolean;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
        current ? "bg-accent" : "hover:bg-accent/50",
      )}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      title={note.path}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <div className={cn("min-w-0 flex-1 truncate text-sm leading-tight", !open && "text-muted-foreground")}>
        {note.title}
      </div>
      {open && !current && <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />}
    </div>
  );
}
