// The note list: every .md in ~/.ledge, sitting under the workspace strip in the
// sidebar. Notes are global to the notes root, so this list is the same whichever
// workspace is selected; what changes per workspace is which of them are open.
//
// There is no rename here on purpose: a note's filename follows its first-line H1
// (notes/store.ts), so you rename a note by retitling it in the editor, and this
// list shows the slug that produced.
//
// Both lists here (notes, trash) are keyboard-navigable row lists: ↑/↓ move the
// focused row, and the row's verbs come from the command registry — Enter opens,
// `d` deletes, `r` restores. The rows publish their identity as data attributes
// (commands/target.ts) and the window dispatcher reads it back, so a right-click
// and a keystroke run the same command against the same note.
import { ChevronRight, FileText, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useListNav } from "@/lib/useListNav";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ContextMenu } from "@/components/ContextMenu";
import { useCommands } from "@/commands/CommandProvider";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { configureUi } from "@/commands/glue";
import { tooltip } from "@/commands/format";
import { targetAttrs } from "@/commands/target";
import { docIdsForPath, openNotePaths, useWorkspace } from "@/workspace/store";
import { focusedTab } from "@/workspace/tree";
import { agoLabel } from "./ago";
import { deleteNote, deleteTrashedNote, emptyTrashNow, restoreNote } from "./actions";
import type { NoteMeta, TrashMeta } from "./channel";

// How long the "Deleted X. Undo" strip stays up. The note does not go anywhere
// when it expires: it is in the Trash section below, which is the whole reason
// this can be a hint rather than a decision the user has to make in eight
// seconds.
const UNDO_MS = 8000;

export function NoteBrowser() {
  const { state, dispatch, selected } = useWorkspace();
  const { exec } = useCommands();
  // Where the right-click menu sits, keyed by path (the note's identity).
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  // A failed delete or restore, shown under the list rather than thrown away into
  // the console.
  const [error, setError] = useState<string | null>(null);
  // The note just deleted, offered back. Keyed by its path in the trash.
  const [undo, setUndo] = useState<{ trashed: string; title: string } | null>(null);
  const nav = useListNav();

  // Sorted by title, NOT by the mtime order the store holds them in: an autosave
  // rewrites mtime on every keystroke burst, so an mtime-sorted list would shuffle
  // itself under the pointer while you type.
  const notes = useMemo(
    () => [...state.notes].sort((a, b) => a.title.localeCompare(b.title)),
    [state.notes],
  );
  const open = useMemo(() => openNotePaths(state), [state]);
  const current = focusedTab(selected)?.path ?? null;

  // The offer expires; the note does not.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

  const trash = (note: NoteMeta) => {
    setError(null);
    void deleteNote(note.path, docIdsForPath(state, note.path), dispatch).then((res) => {
      setError(res.error);
      // No trashed path means the file was already gone, so there is nothing to
      // offer back and an Undo button would be a lie.
      setUndo(res.trashed ? { trashed: res.trashed, title: note.title } : null);
    });
  };

  const restore = (path: string) => {
    setError(null);
    setUndo(null);
    void restoreNote(path, dispatch).then(setError);
  };

  // The browser owns the Undo strip, so it registers the hooks the delete and
  // restore commands (row menus, `d`/`r`, ⌘⌫, the palette) reach it through:
  // every path lands in the same trash-with-undo behavior. Registered via refs
  // because these close over the live state.
  const hooks = useRef({ trash, restore });
  hooks.current = { trash, restore };
  useEffect(() => {
    configureUi({
      deleteNoteWithUndo: (note) => hooks.current.trash(note),
      restoreTrashed: (path) => hooks.current.restore(path),
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline gap-1.5 px-3 pb-1 pt-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Notes
        </span>
        <span className="text-[10px] text-muted-foreground/70">{notes.length || ""}</span>
      </div>

      <div {...nav.containerProps} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {notes.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            No notes yet. A new note is saved to ~/.ledge as soon as you type in it.
          </p>
        ) : (
          notes.map((note, i) => (
            <NoteRow
              key={note.path}
              note={note}
              current={note.path === current}
              open={open.has(note.path)}
              rowProps={nav.rowProps(note.path, i)}
              onOpen={() => exec("note.open", { kind: "note", path: note.path })}
              onContextMenu={(x, y) => setMenu({ path: note.path, x, y })}
            />
          ))
        )}
      </div>

      <TrashSection onRestore={restore} onError={setError} />

      {error && (
        <p className="border-t px-3 py-1.5 text-[11px] leading-snug text-destructive">{error}</p>
      )}

      {undo && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Deleted “{undo.title}”
          </span>
          <button
            className="shrink-0 font-medium text-primary hover:underline"
            onClick={() => restore(undo.trashed)}
          >
            Undo
          </button>
        </div>
      )}

      <button
        className="flex items-center gap-2 border-t px-3.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        title={tooltip("note.new")}
        onClick={() => exec("note.new")}
      >
        <Plus className="size-4" /> New Note
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem
            id="note.open"
            target={{ kind: "note", path: menu.path }}
            onClose={() => setMenu(null)}
          />
          <CommandMenuItem
            id="note.copyPath"
            target={{ kind: "note", path: menu.path }}
            onClose={() => setMenu(null)}
          />
          {/* The command is titled "Delete", deliberately not "Move to Trash":
              that promises the Finder Trash, with Put Back and a Dock icon, and
              this is an app-private folder. No confirmation either: it is
              reversible from the Trash section below, and a prompt in front of
              an undoable action is a tax that teaches people to click through
              prompts. */}
          <CommandMenuItem
            id="note.delete"
            target={{ kind: "note", path: menu.path }}
            onClose={() => setMenu(null)}
            hint="Recoverable from Trash for 30 days"
          />
        </ContextMenu>
      )}
    </div>
  );
}

// --- trash -----------------------------------------------------------------

// Deleted notes, collapsed by default. Hidden entirely when the trash is empty:
// the point of surfacing it is that a full trash is discoverable, and an empty
// one has nothing to discover.
function TrashSection({
  onRestore,
  onError,
}: {
  onRestore: (path: string) => void;
  onError: (err: string | null) => void;
}) {
  const { state, dispatch } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The trashed note queued for permanent deletion, awaiting confirmation.
  const [deleting, setDeleting] = useState<TrashMeta | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  // Sampled once when the section opens rather than read per row at render time,
  // so every row's "2d ago" is measured against the same instant.
  const [now, setNow] = useState(() => Date.now());
  const nav = useListNav();

  const items = state.trash;

  // The section owns both confirmations, so the trash.empty and trash.delete
  // commands open them here rather than deleting directly: the confirm IS the
  // command's behavior, because these are the app's two irreversible actions
  // (docs/interactions.md §4). Opening the section is not required — a row verb
  // can only fire on a row you can see.
  useEffect(() => {
    configureUi({
      confirmEmptyTrash: () => setConfirming(true),
      confirmDeleteTrashed: (item) => setDeleting(item),
    });
  }, []);

  useEffect(() => {
    if (open) setNow(Date.now());
  }, [open, items]);

  if (items.length === 0) return null;

  const empty = () => {
    setConfirming(false);
    onError(null);
    void emptyTrashNow(dispatch).then(onError);
  };

  const deleteForever = (path: string) => {
    setDeleting(null);
    onError(null);
    void deleteTrashedNote(path, dispatch).then(onError);
  };

  return (
    <div className="border-t">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <button
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => setOpen((o) => !o)}
          title="Deleted notes, kept in ~/.ledge/.trash"
        >
          <ChevronRight
            className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Trash
          </span>
          <span className="text-[10px] text-muted-foreground/70">{items.length}</span>
        </button>
        {open && (
          <button
            className="shrink-0 text-[11px] text-muted-foreground hover:text-destructive"
            title={tooltip("trash.empty")}
            onClick={() => setConfirming(true)}
          >
            Empty
          </button>
        )}
      </div>

      {open && (
        <div {...nav.containerProps} className="max-h-48 overflow-y-auto px-1.5 pb-1.5">
          {items.map((item, i) => (
            <TrashRow
              key={item.path}
              item={item}
              now={now}
              rowProps={nav.rowProps(item.path, i)}
              onRestore={() => onRestore(item.path)}
              onContextMenu={(x, y) => setMenu({ path: item.path, x, y })}
            />
          ))}
          <p className="px-2 pt-1.5 text-[10px] leading-snug text-muted-foreground/70">
            Deleted notes are removed for good after 30 days.
          </p>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem
            id="note.restore"
            target={{ kind: "trash", path: menu.path }}
            onClose={() => setMenu(null)}
          />
          <CommandMenuItem
            id="trash.delete"
            target={{ kind: "trash", path: menu.path }}
            onClose={() => setMenu(null)}
            hint="Removes the file from disk. Cannot be undone."
          />
        </ContextMenu>
      )}

      {confirming && (
        <ConfirmDialog
          title="Empty the trash?"
          body={
            items.length === 1
              ? "1 deleted note will be permanently removed. This cannot be undone."
              : `${items.length} deleted notes will be permanently removed. This cannot be undone.`
          }
          confirmLabel="Empty Trash"
          onConfirm={empty}
          onCancel={() => setConfirming(false)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.title}” permanently?`}
          body="This note will be removed from disk. This cannot be undone."
          confirmLabel="Delete Permanently"
          onConfirm={() => deleteForever(deleting.path)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function TrashRow({
  item,
  now,
  rowProps,
  onRestore,
  onContextMenu,
}: {
  item: TrashMeta;
  now: number;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onRestore: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { exec } = useCommands();
  return (
    <div
      {...rowProps}
      {...targetAttrs({ kind: "trash", path: item.path })}
      className={ROW_CLASS}
      title={item.path}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 flex-1 truncate text-[13px] leading-tight text-muted-foreground">
        {item.title}
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60 group-hover:hidden">
        {agoLabel(item.deletedAt, now)}
      </span>
      {/* Both of the row's verbs, revealed together on hover: Restore is the
          one you reach for, so it comes first and Delete Permanently sits at
          the edge, styled destructive. It confirms before it unlinks, which is
          what lets it be a hover target at all. */}
      <button
        className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground group-hover:flex"
        title={tooltip("note.restore")}
        onClick={onRestore}
      >
        <RotateCcw className="size-3" />
      </button>
      <button
        className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:flex"
        title={tooltip("trash.delete")}
        onClick={() => exec("trash.delete", { kind: "trash", path: item.path })}
      >
        <Trash2 className="size-3" />
      </button>
    </div>
  );
}

// --- notes -----------------------------------------------------------------

// Shared by both lists. The focus ring is not decoration: it is the only thing
// telling you which row `d` is about to act on.
const ROW_CLASS =
  "group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring";

// `current` is the note in the focused pane's active tab; `open` is any note with
// a tab somewhere. Clicking either way goes through openNote, which focuses the
// existing tab rather than opening the file a second time.
function NoteRow({
  note,
  current,
  open,
  rowProps,
  onOpen,
  onContextMenu,
}: {
  note: NoteMeta;
  current: boolean;
  open: boolean;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      {...rowProps}
      {...targetAttrs({ kind: "note", path: note.path })}
      className={cn(ROW_CLASS, current && "bg-accent hover:bg-accent")}
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
