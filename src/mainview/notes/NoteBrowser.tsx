// The note list: every .md in the selected workspace's folder, under the
// workspace strip in the sidebar. Notes are local to their workspace, so
// switching workspaces swaps this list and the Trash section below it for the
// new folder's.
//
// A tree drawn as one flat list. Folders come from the notes in them
// (notes/folders.ts) and their open/closed state from notes/expansion.ts.
// browserRows turns the two into rows with a depth, which is all the render
// needs. Flat because the list is keyboard-navigable (interactions.md R5):
// ↑/↓ walk rows by index, and a nested render would have to flatten itself to
// answer "which row is next".
//
// A note is filed by dragging its row onto a folder (or onto the header, the
// top level), or through Move to Folder…. Both call notes/actions.ts
// moveNoteTo, so the drag cannot grow behavior the menu item does not have.
//
// A note has no rename here. Its filename follows its first-line H1
// (notes/store.ts), so retitling it in the editor renames it and this list
// shows the slug it produced. A folder does have one (`r` on the row, the
// workspace strip's own gesture), because a folder has no heading to follow
// and nothing else in the app names it.
//
// Both lists here (notes, trash) are keyboard-navigable row lists. ↑/↓ move
// the focused row, and the row's verbs come from the command registry: Enter
// opens, `d` deletes, `r` restores. The rows publish their identity as data
// attributes (commands/target.ts) and the window dispatcher reads it back, so
// a right-click and a keystroke run the same command against the same note.
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  LayoutTemplate,
  Lock,
  LockOpen,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { notesUnder } from "../../shared/folders";
import { cn } from "@/lib/utils";
import { useListNav } from "@/lib/useListNav";
import { useRowMenu } from "@/lib/useRowMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ContextMenu, MenuDivider } from "@/components/ContextMenu";
import { useCommands } from "@/commands/CommandProvider";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { configureUi } from "@/commands/glue";
import { tooltip } from "@/commands/format";
import { targetAttrs } from "@/commands/target";
import { workspaceKind } from "@/workspace/channel";
import { docIdsForPath, notesOf, openNotePaths, trashOf, useWorkspace } from "@/workspace/store";
import { focusedTab } from "@/workspace/tree";
import { SCRATCH_DOC } from "@/workspace/seeds";
import { useVaultState } from "@/vault/channel";
import { FolderPicker } from "@/components/FolderPicker";
import { RenameField } from "@/components/RenameField";
import type { FolderRequest } from "@/commands/types";
import { agoLabel } from "./ago";
import {
  deleteFolderTo,
  deleteNote,
  deleteTrashedNote,
  emptyTrashNow,
  moveNoteTo,
  renameFolderTo,
  restoreNote,
} from "./actions";
import { createNote } from "./channel";
import { browserRows, folderList, folderOf, folderRowId, type BrowserRow } from "./folders";
import { expandFolder, toggleFolder, useExpanded } from "./expansion";
import { requestTitleCaret } from "@/workspace/editorPool";
import type { NoteMeta, TrashMeta } from "./channel";

// How long the "Deleted X. Undo" strip stays up. The note does not move when
// the strip expires: it sits in the Trash section below and restores from
// there, so the strip is a hint rather than a time limit on undoing.
const UNDO_MS = 8000;

export function NoteBrowser() {
  const { state, dispatch, selected } = useWorkspace();
  const { exec } = useCommands();
  // The vault state drives the locked rows' glyph (closed vs open lock) and
  // which vault verb their menu carries.
  const vault = useVaultState();
  // Where the right-click menu sits, and what it is about: a note (keyed by
  // path, the note's identity) or a folder (keyed by its root-relative path).
  // One piece of state for both, since exactly one menu is ever open.
  const [menu, setMenu] = useState<
    ({ kind: "note"; path: string } | { kind: "folder"; folder: string }) & { x: number; y: number } | null
  >(null);
  // The folder chooser, when Move to Folder… or New Folder… opened it.
  const [picking, setPicking] = useState<FolderRequest | null>(null);
  // The New Note button's dropdown half, where New Folder… lives.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  // The folder a dragged note is currently over: null for the top level (the
  // header), undefined for nothing. Highlighting that target is the only
  // feedback the drag gives, so without it the drop is a guess.
  const [dropOn, setDropOn] = useState<string | null | undefined>(undefined);
  // A failed delete or restore, shown under the list rather than logged only
  // to the console.
  const [error, setError] = useState<string | null>(null);
  // The same strip in a neutral tone, for outcomes that are answers rather
  // than failures (where the CLI shim landed). This one expires; an error
  // stays up.
  const [notice, setNotice] = useState<string | null>(null);
  // The notes just deleted, offered back, keyed by where each landed in the
  // trash. A list because deleting a folder deletes the notes in it: one
  // strip either way, and Undo runs the same restore once per path. `label`
  // is the whole sentence rather than a title, since the two cases do not
  // share a shape ("Deleted “Plan”" against "Deleted 5 notes in “projects”").
  const [undo, setUndo] = useState<{ paths: string[]; label: string } | null>(null);
  // The folder waiting on its delete confirmation (folder.delete). Ephemeral
  // chrome like `renaming`, and it lives here because the note count in the
  // dialog comes from the list this component already holds.
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  // The folder whose row is currently a text field (folder.rename). Ephemeral
  // chrome, so it stays in the component (architecture.md §5). Nothing
  // outside the list reacts to a name being typed.
  const [renaming, setRenaming] = useState<string | null>(null);
  // A row to put focus back on, by list id. A folder's row id is its path
  // (notes/folders.ts folderRowId), so a rename replaces the row and the
  // roving tabindex has nothing left to rove from: without this, `r` drops
  // focus out of the list (interactions.md R5). State and not a ref: the row
  // has to exist before focus can land on it, and only a render puts it there.
  const [refocus, setRefocus] = useState<string | null>(null);
  const nav = useListNav();

  // The built-in Documentation workspace: no create, no delete, no lock. The
  // mutating affordances hide here, and Bun refuses them regardless
  // (bun/workspaces.ts assertWritableRoot).
  const readOnly = workspaceKind(selected.folder) === "docs";
  // The selected workspace's notes only. The sort below is by title, not the
  // mtime order the store holds them in: an autosave rewrites mtime on every
  // keystroke burst, so an mtime-sorted list would reorder under the pointer
  // while typing. The docs workspace sorts by path, whose numbered filenames
  // (bun/docsContent.ts) keep the manual in reading order, not alphabetical.
  const notes = notesOf(state, selected.folder);
  // Which folders are open, from the module the commands also write
  // (notes/expansion.ts): Move to Folder… and New Note in Folder both have to
  // reveal where the note landed, so the state cannot live in this component.
  const expanded = useExpanded(selected.folder);
  // The tree, flattened. browserRows applies the sort within each folder.
  const rows = useMemo(
    () =>
      browserRows(notes, expanded, (a, b) =>
        readOnly ? a.path.localeCompare(b.path) : a.title.localeCompare(b.title),
      ),
    [notes, expanded, readOnly],
  );
  // Every folder of this workspace, for the chooser's list.
  const folders = useMemo(() => folderList(notes), [notes]);
  const open = useMemo(() => openNotePaths(state), [state]);
  const current = focusedTab(selected)?.path ?? null;
  // The note the open menu points at: its live locked flag picks which lock
  // face (and which vault verb) the menu carries.
  const menuNote = menu?.kind === "note" ? notes.find((n) => n.path === menu.path) : undefined;

  // A rename field belongs to a row of the workspace it was opened in.
  // Switching workspaces from the keyboard leaves no blur behind to close it,
  // so a folder of the same name in the new workspace would inherit the field
  // and the rename.
  useEffect(() => setRenaming(null), [selected.folder]);

  // Put focus back on a row the render just replaced (a renamed folder).
  useEffect(() => {
    if (refocus === null) return;
    setRefocus(null);
    nav.containerProps.ref.current?.querySelector<HTMLElement>(`[data-list-row="${CSS.escape(refocus)}"]`)?.focus();
    // `nav`'s ref is stable for the component's life, so `refocus` is the
    // only dependency.
  }, [refocus]);

  // Clear the Undo offer after UNDO_MS. The note stays in the trash.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

  // The notice strip clears on the same timeout as the Undo offer. Both are
  // temporary strips, so one constant covers them.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const trash = (note: NoteMeta) => {
    setError(null);
    void deleteNote(note.path, selected.folder, docIdsForPath(state, note.path), dispatch).then((res) => {
      setError(res.error);
      // No trashed path means the file was already gone, so there is nothing
      // to offer back and no strip.
      setUndo(res.trashed ? { paths: [res.trashed], label: `Deleted “${note.title}”` } : null);
    });
  };

  const restore = (path: string) => {
    setError(null);
    setUndo(null);
    void restoreNote(path, selected.folder, dispatch).then(setError);
  };

  // The Undo strip's button: one note, or a folder's worth. Restores run one
  // at a time. A restore lands its note under a free name in its folder, and
  // two running at once could pick the same free name. A failure is reported
  // and the remaining paths still run, so one note that will not come back
  // does not block the rest.
  const undoAll = async (paths: readonly string[]) => {
    setError(null);
    setUndo(null);
    let failure: string | null = null;
    for (const path of paths) failure = (await restoreNote(path, selected.folder, dispatch)) ?? failure;
    setError(failure);
  };

  // File a note, from the chooser or from a drop. One path for both, so the
  // drag cannot grow behavior the menu item does not have. The destination is
  // expanded first: the note has to arrive somewhere on screen, and expanding
  // after the move would flash the row into a closed folder.
  const file = (note: NoteMeta, folder: string | null) => {
    setError(null);
    if (folder !== null) expandFolder(selected.folder, folder);
    void moveNoteTo(note.path, folder, docIdsForPath(state, note.path), dispatch).then((res) => {
      setError(res.error);
    });
  };

  // Rename a folder in place. Every note under it is about to be at a new
  // path, so the tabs open on them are handed over too (actions.ts
  // renameFolderTo freezes the saves and carries the open folders over).
  const rename = (folder: string, name: string) => {
    setError(null);
    // Built before anything awaits, from the state this render closed over.
    // The rename is about to invalidate which tabs hold which note.
    const docs = new Map(notesUnder(notes, folder).map((n) => [n.path, docIdsForPath(state, n.path)] as const));
    void renameFolderTo(selected.folder, folder, name, docs, dispatch).then((res) => {
      setError(res.error);
      // Focus the row under its new name, so `r` leaves the keyboard on the
      // list. On a refusal the row never moved, so the old folder is its id.
      setRefocus(folderRowId(res.folder ?? folder));
    });
  };

  // Delete a folder, which means deleting the notes in it. The open tabs are
  // collected before anything awaits, for rename's reason: the delete is
  // about to invalidate which tabs hold which note.
  const removeFolder = (folder: string) => {
    setError(null);
    const doomed = notesUnder(notes, folder);
    const docs = new Map(doomed.map((n) => [n.path, docIdsForPath(state, n.path)] as const));
    void deleteFolderTo(selected.folder, folder, docs, dispatch).then((res) => {
      setError(res.error);
      // Nothing trashed means nothing to offer back, so no strip. That is a
      // refusal, or a folder whose notes were already gone from disk.
      const n = res.trashed.length;
      setUndo(
        n > 0
          ? {
              paths: res.trashed.map((t) => t.to),
              label: `Deleted ${n === 1 ? "1 note" : `${n} notes`} in “${folder}”`,
            }
          : null,
      );
    });
  };

  // The browser owns the Undo strip, so it registers the hooks the delete and
  // restore commands reach it through (row menus, `d`/`r`, ⌘⌫, the palette).
  // Every one of those lands in the same trash-with-undo behavior. Held in a
  // ref because the handlers close over the live state.
  const hooks = useRef({ trash, restore, file, rename, removeFolder });
  hooks.current = { trash, restore, file, rename, removeFolder };
  useEffect(() => {
    configureUi({
      deleteNoteWithUndo: (note) => hooks.current.trash(note),
      restoreTrashed: (path) => hooks.current.restore(path),
      // Move to Folder… and New Folder… both stop here for a destination.
      // `picked` below decides what happens after, by which request it was.
      pickFolder: (request) => setPicking(request),
      // The field replaces a row, so only the list can put it there.
      beginRenameFolder: (folder) => setRenaming(folder),
      confirmDeleteFolder: (folder) => setDeletingFolder(folder),
      // The browser's error strip doubles as the workspace commands' error
      // surface (a refused attach, a failed create), so every failure is
      // reported in the same place.
      showError: (message) => setError(message),
      showNotice: (message) => setNotice(message),
    });
  }, []);

  // What the chooser's pick means. A move files the note it was opened on.
  // Naming a new folder writes the first note into it, because the browser
  // derives folders from the notes in them and cannot show an empty one
  // (notes/folders.ts).
  const picked = (folder: string | null) => {
    const request = picking;
    setPicking(null);
    if (!request) return;
    if (request.kind === "move") {
      file(request.note, folder);
      return;
    }
    if (folder === null) return; // "New Folder" cannot mean the workspace root
    setError(null);
    expandFolder(selected.folder, folder);
    void createNote(selected.folder, SCRATCH_DOC, folder).then(
      (note) => {
        requestTitleCaret(note.path, true);
        // note.newInFolder dispatches the same pair: into the list and into a
        // tab. The folder row exists only because this note is in it, so the
        // row and the tab arrive together.
        dispatch({ type: "noteAppeared", folder: selected.folder, note });
        dispatch({ type: "openNote", note });
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The header doubles as the top level's drop target: dragging a note
          here files it out of whatever folder it is in. The top level is the
          one destination with no row of its own. */}
      <div
        className={cn(
          "flex items-baseline gap-1.5 px-3 pb-1 pt-2.5",
          dropOn === null && "bg-accent/60",
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(NOTE_DRAG)) return;
          e.preventDefault();
          setDropOn(null);
        }}
        onDragLeave={() => setDropOn(undefined)}
        onDrop={(e) => {
          setDropOn(undefined);
          const note = notes.find((n) => n.path === e.dataTransfer.getData(NOTE_DRAG));
          if (note && folderOf(note) !== "") file(note, null);
        }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Notes
        </span>
        <span className="text-[10px] text-muted-foreground/70">{notes.length || ""}</span>
        {readOnly && (
          <span
            className="ml-auto rounded border px-1 text-[10px] leading-4 text-muted-foreground/80"
            title="The built-in documentation cannot be edited or deleted"
          >
            read-only
          </span>
        )}
      </div>

      <div {...nav.containerProps} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {rows.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            No notes yet. A new note is saved to this workspace's folder as soon as you type in it.
          </p>
        ) : (
          rows.map((row, i) =>
            row.kind === "folder" ? (
              <FolderRow
                key={row.id}
                row={row}
                dropping={dropOn === row.folder}
                renaming={renaming === row.folder}
                rowProps={nav.rowProps(row.id, i)}
                onRename={(name) => rename(row.folder, name)}
                onEndRename={() => setRenaming(null)}
                onToggle={() => toggleFolder(selected.folder, row.folder)}
                onDropNote={(path) => {
                  const note = notes.find((n) => n.path === path);
                  if (note && folderOf(note) !== row.folder) file(note, row.folder);
                }}
                onDropTarget={setDropOn}
                onContextMenu={(x, y) => setMenu({ kind: "folder", folder: row.folder, x, y })}
              />
            ) : (
              <NoteRow
                key={row.id}
                note={row.note}
                depth={row.depth}
                current={row.note.path === current}
                open={open.has(row.note.path)}
                unlocked={vault === "unlocked"}
                draggable={!readOnly}
                rowProps={nav.rowProps(row.id, i)}
                onOpen={() => exec("note.open", { kind: "note", path: row.note.path })}
                onContextMenu={(x, y) => setMenu({ kind: "note", path: row.note.path, x, y })}
              />
            ),
          )
        )}
      </div>

      <TrashSection onRestore={restore} onError={setError} />

      {error && (
        <p className="border-t px-3 py-1.5 text-[11px] leading-snug text-destructive">{error}</p>
      )}

      {notice && (
        <p className="border-t px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">{notice}</p>
      )}

      {undo && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{undo.label}</span>
          <button
            className="shrink-0 font-medium text-primary hover:underline touch:min-h-[44px] touch:px-2"
            onClick={() => void undoAll(undo.paths)}
          >
            Undo
          </button>
        </div>
      )}

      {/* A split button, on the workspace strip's pattern: the wide half is
          New Note, the chevron opens a menu holding New Folder…. That verb's
          only other pointer surface is a folder row's menu, and a workspace
          with no folders yet has no such row, which would leave the palette
          as its only door. */}
      {!readOnly && (
        <div className="flex border-t">
          <button
            className="flex flex-1 items-center gap-2 px-3.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground touch:min-h-[44px]"
            title={tooltip("note.new")}
            onClick={() => exec("note.new")}
          >
            <Plus className="size-4" /> New Note
          </button>
          <button
            aria-label="New note options"
            title="New note options"
            // The narrow half of a split button, given a touch width of its
            // own: the halves touch, and a miss on this one creates a note.
            className="flex items-center border-l px-2.5 text-muted-foreground hover:bg-accent hover:text-foreground touch:min-w-[44px] touch:justify-center"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setAddMenu({ x: Math.max(8, r.right - 220), y: r.top - 8 });
            }}
          >
            <ChevronDown className="size-3.5" />
          </button>
        </div>
      )}

      {addMenu && (
        <ContextMenu x={addMenu.x} y={addMenu.y} onClose={() => setAddMenu(null)}>
          <CommandMenuItem
            id="folder.new"
            hint="A folder holds notes, so Ledge opens one in it"
            onClose={() => setAddMenu(null)}
          />
        </ContextMenu>
      )}

      {/* A folder row's menu: its Enter verb (Expand or Collapse, titled by
          the live state), searching inside it, a note in it, and a folder
          inside it. That last one is the only way a pointer nests a folder. */}
      {menu?.kind === "folder" && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem
            id="folder.toggle"
            target={{ kind: "folder", folder: menu.folder }}
            onClose={() => setMenu(null)}
          />
          {/* Above the readOnly gate: searching inside a folder only reads,
              so the manual's own pages keep the verb. */}
          <CommandMenuItem
            id="folder.search"
            target={{ kind: "folder", folder: menu.folder }}
            onClose={() => setMenu(null)}
          />
          {!readOnly && (
            <>
              <CommandMenuItem
                id="folder.rename"
                target={{ kind: "folder", folder: menu.folder }}
                onClose={() => setMenu(null)}
              />
              <CommandMenuItem
                id="note.newInFolder"
                target={{ kind: "folder", folder: menu.folder }}
                onClose={() => setMenu(null)}
              />
              <CommandMenuItem
                id="folder.new"
                target={{ kind: "folder", folder: menu.folder }}
                onClose={() => setMenu(null)}
              />
              {/* Below a divider (interactions.md §4): a destructive item
                  does not sit flush against a safe sibling, and the two New…
                  verbs above are what a slip would land on. */}
              <MenuDivider />
              <CommandMenuItem
                id="folder.delete"
                target={{ kind: "folder", folder: menu.folder }}
                onClose={() => setMenu(null)}
                hint="Its notes are recoverable from Trash"
              />
            </>
          )}
        </ContextMenu>
      )}

      {menu?.kind === "note" && (
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
          {/* A doc page's menu ends here. The lock faces and Delete are
              absent rather than disabled, since no row in this workspace can
              ever take them. */}
          {!readOnly && (
            <>
          {/* Filing, above the lock faces and well clear of Delete. Move and
              Delete both relocate the note's file, but the destructive one
              keeps the bottom of the menu to itself (interactions.md §4). */}
          <CommandMenuItem
            id="note.move"
            target={{ kind: "note", path: menu.path }}
            onClose={() => setMenu(null)}
          />
          {/* The two lock faces, one at a time (locking.md §7): Lock This
              Note… on a plain row, disabled on a template note (locking.md
              §2), and Remove Lock… on a locked one. A locked row also carries
              the vault verb matching its glyph. That verb is vault-wide. It
              sits here because the glyph is where the vault's state shows. */}
          {menuNote?.locked ? (
            <>
              <CommandMenuItem
                id={vault === "unlocked" ? "vault.lock" : "vault.unlock"}
                onClose={() => setMenu(null)}
              />
              <CommandMenuItem
                id="note.lockOff"
                target={{ kind: "note", path: menu.path }}
                onClose={() => setMenu(null)}
              />
            </>
          ) : (
            <CommandMenuItem
              id="note.lockOn"
              target={{ kind: "note", path: menu.path }}
              onClose={() => setMenu(null)}
            />
          )}
          {/* The command is titled "Delete", not "Move to Trash": that would
              promise the Finder Trash, with Put Back and a Dock icon, and this
              trash is an app-private folder. No confirmation either, because
              the Trash section below reverses it (interactions.md §4). */}
          <CommandMenuItem
            id="note.delete"
            target={{ kind: "note", path: menu.path }}
            onClose={() => setMenu(null)}
            hint="Recoverable from Trash for 30 days"
          />
            </>
          )}
        </ContextMenu>
      )}

      {/* Deleting a folder deletes the notes in it, and the dialog states the
          count: a collapsed row does not say whether `d` costs one note or
          forty. This is not an irreversibility warning. The notes land in the
          Trash a line below and the Undo strip comes up behind the dialog, so
          the body says where they went (interactions.md §4). */}
      {deletingFolder !== null && (
        <ConfirmDialog
          title={`Delete “${deletingFolder}”?`}
          body={
            notesUnder(notes, deletingFolder).length === 1
              ? "Its 1 note moves to the Trash, where Undo and Restore bring it back."
              : `Its ${notesUnder(notes, deletingFolder).length} notes move to the Trash, including everything in the folders inside it. Undo and Restore bring them back.`
          }
          confirmLabel="Delete Folder"
          onConfirm={() => {
            const folder = deletingFolder;
            setDeletingFolder(null);
            removeFolder(folder);
          }}
          onCancel={() => setDeletingFolder(null)}
        />
      )}

      {/* The destination chooser. One dialog for both verbs, because both ask
          the same question (components/FolderPicker.tsx). */}
      {picking && (
        <FolderPicker
          title={picking.kind === "move" ? "Move to Folder" : "New Folder"}
          description={
            picking.kind === "move"
              ? `Where should “${picking.note.title}” go? Its images and links follow it.`
              : "Name a folder for this workspace. A new note opens in it, because Ledge shows the folders its notes are in."
          }
          folders={folders}
          allowRoot={picking.kind === "move"}
          initialQuery={picking.kind === "new" ? picking.parent : ""}
          onPick={picked}
          onCancel={() => setPicking(null)}
        />
      )}
    </div>
  );
}

// --- trash -----------------------------------------------------------------

// Deleted notes, collapsed by default. The section renders nothing while the
// trash is empty: it exists to make a full trash visible.
function TrashSection({
  onRestore,
  onError,
}: {
  onRestore: (path: string) => void;
  onError: (err: string | null) => void;
}) {
  const { state, dispatch, selected } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The trashed note queued for permanent deletion, awaiting confirmation.
  const [deleting, setDeleting] = useState<TrashMeta | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  // Sampled when the section opens or its items change, not per row at render
  // time, so every row's "2d ago" measures from the same instant.
  const [now, setNow] = useState(() => Date.now());
  const nav = useListNav();

  // The selected workspace's trash: each folder keeps its own.
  const items = trashOf(state, selected.folder);

  // The section owns both confirmations, so trash.empty and trash.delete open
  // a dialog here rather than deleting. That confirm is the command's own
  // behavior, for the app's two irreversible actions (interactions.md §4).
  // Both dialogs render while the section is collapsed, which trash.empty
  // needs from the palette. trash.delete fires only on a visible row.
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
    void emptyTrashNow(selected.folder, dispatch).then(onError);
  };

  const deleteForever = (path: string) => {
    setDeleting(null);
    onError(null);
    void deleteTrashedNote(path, selected.folder, dispatch).then(onError);
  };

  return (
    <div className="border-t">
      {/* Both buttons are 44 points on touch (interactions.md §1a). The
          disclosure is 13 points on its own, which was the smallest target in
          the app. It sits just above the New Note button, so a miss creates a
          file. Empty is destructive and sits at the far end of the same row,
          so it is sized here too. */}
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <button
          className="flex min-w-0 flex-1 items-center gap-1 text-left touch:min-h-[44px]"
          onClick={() => setOpen((o) => !o)}
          title="Deleted notes, kept in this workspace folder's .ledge-trash"
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
            className="shrink-0 text-[11px] text-muted-foreground hover:text-destructive touch:min-h-[44px] touch:px-2"
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
  // Right-click, or a finger held on the row: both open this row's menu, which
  // is where Delete Permanently lives for anyone without a hover.
  const press = useRowMenu(onContextMenu);
  return (
    <div
      {...rowProps}
      {...targetAttrs({ kind: "trash", path: item.path })}
      {...press}
      className={ROW_CLASS}
      title={item.path}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 flex-1 truncate text-[13px] leading-tight text-muted-foreground">
        {item.title}
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60 group-hover:hidden">
        {agoLabel(item.deletedAt, now)}
      </span>
      {/* The row's two verbs, revealed together on hover. Restore comes first
          as the common one. Delete Permanently sits at the edge, styled
          destructive, and confirms before it unlinks (interactions.md §4),
          which is what lets it be a hover target at all. */}
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

// The class both lists share. The focus ring is what says which row `d` is
// about to act on. Rows are 44 points on touch for the reason MenuItem is
// (interactions.md §1a): they are stacked with no gap between them, so a miss
// opens the wrong note. `min-h` and not `h`, so a taller row keeps its own
// height.
const ROW_CLASS =
  "group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]";

// The drag's own MIME type, carrying the dragged note's path. A custom type
// rather than text/plain because dataTransfer.types is readable during
// dragover while the data is not. A drop target checks the type before it
// claims the drop, so a drag from outside the app (a file, a selection) falls
// through to the page instead.
const NOTE_DRAG = "application/x-ledge-note";

// How far a row indents per level, in pixels. Small because the sidebar is
// narrow: a note three folders down still has to show enough of its title to
// be recognised.
const INDENT = 12;

// One note's row. `current` is the note in the focused pane's active tab;
// `open` is any note with a tab somewhere. A click runs note.open either way,
// and the openNote action it dispatches focuses the existing tab rather than
// opening the file a second time (workspace/store.tsx).
function NoteRow({
  note,
  depth,
  current,
  open,
  unlocked,
  draggable,
  rowProps,
  onOpen,
  onContextMenu,
}: {
  note: NoteMeta;
  depth: number;
  current: boolean;
  open: boolean;
  // Vault state, for the locked rows' glyph: open lock while unlocked.
  unlocked: boolean;
  // Whether the row can be dragged. Off in the read-only manual, where there
  // is nowhere to drop a note.
  draggable: boolean;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  // A click opens the note. A press held on the row opens the menu instead.
  // useRowMenu swallows the click WebKit sends afterwards, so a long press
  // does not also open the note it was asking about (interactions.md §1a).
  const press = useRowMenu(onContextMenu, onOpen);
  return (
    <div
      {...rowProps}
      {...targetAttrs({ kind: "note", path: note.path })}
      {...press}
      // Dragging a row is a pointer gesture, not a command (interactions.md
      // R4): its affordance is the drag image and the target's highlight. The
      // long press that opens the menu is touch and pen only, so a held left
      // button reaches this instead and the two cannot collide
      // (lib/useRowMenu.ts).
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(NOTE_DRAG, note.path);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(ROW_CLASS, current && "bg-accent hover:bg-accent")}
      style={{ paddingLeft: 8 + depth * INDENT }}
      title={note.path}
    >
      {/* The glyph names the row's kind, wearing the command's own icon: ⌘J's
          CalendarDays for a daily-role note (template: daily), LayoutTemplate
          for any other template note, the vault's Lock for a locked one, which
          opens while the vault is unlocked (locking.md §7). The markers are
          mutually exclusive, so the column reads one kind per row. */}
      {note.template === "daily" ? (
        <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
      ) : note.template ? (
        <LayoutTemplate className="size-3.5 shrink-0 text-muted-foreground" />
      ) : note.locked ? (
        unlocked ? (
          <LockOpen data-testid="note-unlocked-glyph" className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Lock data-testid="note-locked-glyph" className="size-3.5 shrink-0 text-muted-foreground" />
        )
      ) : (
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className={cn("min-w-0 flex-1 truncate text-sm leading-tight", !open && "text-muted-foreground")}>
        {note.title}
      </div>
      {open && !current && <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />}
    </div>
  );
}

// --- folders ---------------------------------------------------------------

// One folder of the workspace. Its Enter verb is the disclosure, since showing
// what is in a folder is its primary action (interactions.md R6), and a click
// toggles it too. The row is also a drop target: dragging a note onto it files
// the note there. It claims the drop only for a Ledge note (NOTE_DRAG), so a
// file dragged in from the Finder falls through instead.
function FolderRow({
  row,
  dropping,
  renaming,
  rowProps,
  onRename,
  onEndRename,
  onToggle,
  onDropNote,
  onDropTarget,
  onContextMenu,
}: {
  row: Extract<BrowserRow, { kind: "folder" }>;
  dropping: boolean;
  renaming: boolean;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onRename: (name: string) => void;
  onEndRename: () => void;
  onToggle: () => void;
  onDropNote: (path: string) => void;
  onDropTarget: (folder: string | null | undefined) => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const press = useRowMenu(onContextMenu, onToggle);
  return (
    <div
      {...rowProps}
      {...targetAttrs({ kind: "folder", folder: row.folder })}
      // While the rename field is up the row drops its press handlers. A tap
      // then places the caret rather than toggling the folder, and a long
      // press selects text rather than opening the menu.
      {...(renaming ? {} : press)}
      onDragOver={(e) => {
        if (renaming) return; // the pointer belongs to the field
        if (!e.dataTransfer.types.includes(NOTE_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDropTarget(row.folder);
      }}
      onDragLeave={() => onDropTarget(undefined)}
      onDrop={(e) => {
        onDropTarget(undefined);
        const path = e.dataTransfer.getData(NOTE_DRAG);
        if (path) onDropNote(path);
      }}
      className={cn(ROW_CLASS, dropping && "bg-accent ring-1 ring-ring")}
      style={{ paddingLeft: 8 + row.depth * INDENT }}
      title={row.folder}
    >
      {/* The chevron shows whether the folder is expanded. The folder glyph
          beside it shows the same state a second way. */}
      <ChevronRight
        className={cn(
          "size-3 shrink-0 text-muted-foreground transition-transform",
          row.expanded && "rotate-90",
        )}
      />
      {row.expanded ? (
        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      {renaming ? (
        // Seeded with the name, not the path: a rename changes what the folder
        // is called, not where it sits. A field holding `projects/api` would
        // invite a `/`, which the rename refuses (shared/folders.ts).
        <RenameField initial={row.name} onCommit={onRename} onDone={onEndRename} />
      ) : (
        <div className="min-w-0 flex-1 truncate text-sm leading-tight">{row.name}</div>
      )}
      {/* How many notes the disclosure is hiding, so a collapsed folder still
          says how much is in it. Hidden while the folder is open, where the
          rows say it, and while it is being renamed, where the field wants the
          width. */}
      {!row.expanded && !renaming && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{row.count}</span>
      )}
    </div>
  );
}
