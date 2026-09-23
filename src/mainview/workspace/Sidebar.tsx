import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModHeld } from "@/lib/useModHeld";
import { useListNav } from "@/lib/useListNav";
import { onBlankSpace, useRowMenu } from "@/lib/useRowMenu";
import { ResizeHandle } from "@/components/ResizeHandle";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ContextMenu, MenuDivider } from "@/components/ContextMenu";
import { RenameField } from "@/components/RenameField";
import { NoteBrowser } from "@/notes/NoteBrowser";
import { NOTE_DRAG } from "@/notes/drag";
import { agoLabel } from "@/notes/ago";
import { docsWindow } from "@/lib/windows";
import { ConnectionBar } from "./ConnectionBar";
import { useCommands, useCommandTitle } from "@/commands/CommandProvider";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { configureUi, uiHooks } from "@/commands/glue";
import { jumpBadge, keyChip, tooltip } from "@/commands/format";
import { workspaceSelectKey } from "@/commands/keys";
import { targetAttrs } from "@/commands/target";
import { deleteDeletedWorkspace, restoreDeletedWorkspace } from "./actions";
import {
  refreshTrashedWorkspaces,
  useTrashedWorkspaces,
  workspaceKind,
  type TrashedWorkspace,
} from "./channel";
import { useWorkspace } from "./store";
import { IconPicker } from "./IconPicker";
import { iconFor } from "./icons";
import { countTabs, leafIds, type Workspace } from "./tree";

// How the sidebar splits between its two sections, and the room each keeps when
// the divider is dragged to an extreme.
const STRIP_DEFAULT = 200;
const STRIP_MIN = 88;
const NOTES_MIN = 120;
// Below this height the sidebar stops splitting and stacks instead: one column
// that scrolls, the strip above the note list at their natural heights. Two
// sections that each scroll need room for a few rows apiece plus the rows that
// never scroll (the connection bar, Trash, New Workspace, New Note, 44 points
// each on touch), and under 480 there is none. A phone on its side has 324
// (ios.md §9); a Mac window this short gets the same answer.
const STACK_BELOW = 480;

// The sidebar: the workspace strip on top, the note list below, divided by a
// draggable handle. The strip lists the workspaces, each of which is a
// collection of tabs and panes. The browser lists the selected workspace's
// notes (NoteBrowser.tsx). Both sections stay visible at once where there is
// height for both; where there is not, the sidebar is one scrolling column.
export function Sidebar() {
  const [stripHeight, setStripHeight] = useState(STRIP_DEFAULT);
  // The sidebar's live height, measured because the split depends on it and
  // the strip's height is clamped against it. Null until the first layout.
  const [avail, setAvail] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setAvail(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The strip's height is clamped against the container on every layout, not
  // only when the divider is dragged, so a window that shrinks after the
  // sidebar mounted cannot push the note list's rows off the bottom and out
  // of reach. App.tsx measures the same way for the terminal drawer.
  const resize = useCallback((h: number) => setStripHeight(h), []);
  const stacked = avail !== null && avail < STACK_BELOW;
  const height =
    avail === null ? stripHeight : Math.max(STRIP_MIN, Math.min(stripHeight, avail - NOTES_MIN));

  // In the manual's window the sidebar shows the manual's contents at full
  // height (remote.md §8a). The strip would be an empty list under a heading,
  // since the docs workspace is filtered out of it and that window has none of
  // the verbs that add a workspace. The connection bar would name a machine
  // that window cannot be switched off.
  if (docsWindow()) {
    return (
      <aside className="flex h-full w-full min-w-0 flex-col bg-muted/20">
        <NoteBrowser />
      </aside>
    );
  }

  return (
    <aside
      ref={ref}
      data-stacked={stacked || undefined}
      className={cn("flex h-full w-full min-w-0 flex-col bg-muted/20", stacked && "overflow-y-auto")}
    >
      {/* The connection bar sits above the strip because it scopes it: the
          workspaces below, their notes, and their shells all belong to the
          machine named here (remote.md §8). */}
      <ConnectionBar />
      <div
        style={stacked ? undefined : { height }}
        className="flex min-h-0 shrink-0 flex-col"
      >
        <WorkspaceStrip stacked={stacked} />
      </div>
      {!stacked && (
        <ResizeHandle axis="y" current={height} onResize={resize} title="Drag to resize" />
      )}
      <NoteBrowser stacked={stacked} />
    </aside>
  );
}

// The vertical workspace strip. Workspaces stack and scroll down the side; each
// carries its own pane tree, so switching preserves every workspace's splits,
// tabs, and selection (the tree lives in the store, the editors in the pool).
// Row icons come from the catalog in icons.ts and are chosen per workspace.

// The workspace id being dragged, read synchronously inside drop handlers. Kept
// outside React state (like the tab drag in PaneTree) so drag start needs no
// re-render.
let draggingWs: string | null = null;

// `stacked`: the sidebar is one scrolling column (Sidebar above), so the list
// takes its natural height and scrolls with the column instead of within it.
function WorkspaceStrip({ stacked }: { stacked: boolean }) {
  const { state, dispatch } = useWorkspace();
  const { exec } = useCommands();
  const modHeld = useModHeld();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The right-click menu: which workspace, and where to anchor it. Null when closed.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // The add menu (New Workspace / Attach Folder…), opened by the + row's
  // chevron or by a right-click on the strip's blank space. Null when closed.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  // The workspace whose icon is being picked, and the row the popover hangs off.
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [pickAnchor, setPickAnchor] = useState<HTMLElement | null>(null);
  // The strip owns the inline-rename state and the icon picker. It registers
  // the hooks that workspace.rename and workspace.icon reach it through
  // (registry.ts), whether they are run from a menu item, a row verb, or the
  // palette. The Attach Folder dialog is App's (App.tsx): a phone keeps the
  // sidebar unmounted, and a dialog owned here would not open there.
  useEffect(() => {
    configureUi({
      beginRenameWorkspace: setRenamingId,
      pickWorkspaceIcon: setPickingId,
    });
  }, []);

  // Where an in-flight drop would land, as an index into the strip's rows.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // The workspace row a dragged NOTE is over, by id. A note dragged out of
  // the browser onto a row moves to that workspace (interactions.md §3, Move
  // to Workspace…); the highlight is the only feedback the drag gives.
  const [noteDropOn, setNoteDropOn] = useState<string | null>(null);
  const nav = useListNav();
  const listRef = nav.containerProps.ref;

  // The rows the strip shows: every workspace except the built-in docs one.
  // The docs workspace is reached from the header's help button (App.tsx)
  // instead. While it is selected no row highlights. The way back is any row,
  // or ⌘1…9, which index this same filtered list (registry.ts).
  const strip = state.workspaces.filter((ws) => workspaceKind(ws.folder) !== "docs");

  // The icon picker anchors to a row, and the row's position comes from the
  // DOM. A workspace with no row rendered has nothing to anchor to, so the
  // open is dropped rather than left as an invisible popover holding the
  // Escape layer.
  useLayoutEffect(() => {
    if (!pickingId) {
      setPickAnchor(null);
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-ws][data-target-id="${CSS.escape(pickingId)}"]`,
    );
    if (row) setPickAnchor(row);
    else setPickingId(null);
  }, [pickingId, listRef]);

  // The slot the cursor is over: the count of rows whose vertical midpoint sits
  // above it (0..strip.length). Measured off the live DOM so it tracks the
  // real rendered heights and scroll offset.
  const slotAt = (clientY: number): number => {
    const list = listRef.current;
    if (!list) return strip.length;
    const items = list.querySelectorAll<HTMLElement>("[data-ws]");
    let i = 0;
    for (const item of items) {
      const r = item.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
      i += 1;
    }
    return items.length;
  };

  // A strip slot as an index into the full workspace list, which may also hold
  // the hidden docs workspace. The reducer's moveWorkspace indexes that whole
  // list (store.tsx), so the slot resolves to the workspace it lands before. A
  // drop past the last row moves the workspace to the end of the full list, so
  // where the hidden workspace sits in the array does not matter.
  const fullIndexOf = (slot: number): number => {
    const anchor = strip[slot];
    return anchor ? state.workspaces.findIndex((w) => w.id === anchor.id) : state.workspaces.length;
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!draggingWs) return;
    e.preventDefault(); // allow the drop
    e.dataTransfer.dropEffect = "move";
    setDropIndex(slotAt(e.clientY));
  };

  const onDrop = (e: React.DragEvent) => {
    if (!draggingWs) return;
    e.preventDefault();
    dispatch({ type: "moveWorkspace", id: draggingWs, toIndex: fullIndexOf(slotAt(e.clientY)) });
    draggingWs = null;
    setDropIndex(null);
  };

  // A note dropped on a workspace row. The path is the drag's data
  // (notes/NoteBrowser.tsx), looked up in the lists the view holds. The
  // browser runs the move and owns the Undo strip that follows
  // (uiHooks.moveNoteToWorkspace), the same path its chooser takes.
  const dropNote = (path: string, ws: Workspace) => {
    setNoteDropOn(null);
    const note = Object.values(state.notes).flat().find((n) => n.path === path);
    if (note) uiHooks.moveNoteToWorkspace?.(note, ws.folder);
  };

  // The marker clears only when the pointer leaves the list itself, not when
  // it crosses between rows (those fire dragleave on the parent too).
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null);
  };

  return (
    <>
      <div className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Workspaces
      </div>
      <div
        {...nav.containerProps}
        data-testid="workspace-strip"
        className={cn("px-1.5 pb-2", stacked ? "shrink-0" : "min-h-0 flex-1 overflow-y-auto")}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
        // A right-click below the last row opens the same menu the + row's
        // chevron does, because the strip's blank space is the strip itself
        // (interactions.md R6b). A click on a row opened that row's menu on
        // the way up here.
        onContextMenu={(e) => {
          if (!onBlankSpace(e.target)) return;
          e.preventDefault();
          setAddMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {strip.map((ws, i) => (
          <div key={ws.id}>
            {dropIndex === i && <DropMarker />}
            <WorkspaceRow
              ws={ws}
              selected={ws.id === state.selectedId}
              renaming={renamingId === ws.id}
              canClose={strip.length > 1}
              hint={modHeld && i < 9 ? i + 1 : null}
              rowProps={nav.rowProps(ws.id, i)}
              onSelect={() => exec("workspace.open", { kind: "workspace", id: ws.id })}
              onBeginRename={() => setRenamingId(ws.id)}
              onEndRename={() => setRenamingId(null)}
              onRename={(name) => dispatch({ type: "renameWorkspace", id: ws.id, name })}
              onRemove={() => exec("workspace.remove", { kind: "workspace", id: ws.id })}
              onDragStart={() => (draggingWs = ws.id)}
              onDragEnd={() => {
                draggingWs = null;
                setDropIndex(null);
              }}
              dropping={noteDropOn === ws.id}
              onNoteDragOver={() => setNoteDropOn(ws.id)}
              onNoteDragLeave={() => setNoteDropOn(null)}
              onDropNote={(path) => dropNote(path, ws)}
              onContextMenu={(x, y) => {
                dispatch({ type: "selectWorkspace", id: ws.id });
                setMenu({ id: ws.id, x, y });
              }}
            />
          </div>
        ))}
        {dropIndex === strip.length && <DropMarker />}
      </div>
      <WorkspaceTrashSection />
      {/* A split button: the wide half runs New Workspace, the chevron opens a
          menu of both ways to add one. Attach Folder has no chord (keys.ts);
          this menu, the File menu (menu.ts) and the palette are its three
          homes. The chevron opens a menu rather than running a command, so its
          hand-written title is allowed (interactions.md §5). */}
      <div className="flex border-t">
        <button
          className="flex flex-1 items-center gap-2 px-3.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground touch:min-h-[44px]"
          title={tooltip("workspace.new")}
          onClick={() => exec("workspace.new")}
        >
          <Plus className="size-4" /> New Workspace
        </button>
        <button
          aria-label="Add workspace options"
          title="Add workspace options"
          // The narrow half of a split button. The touch:min-w-[44px] class
          // below gives it a 44 point width of its own (interactions.md §1a).
          // The two halves touch, so a miss on the chevron creates a workspace
          // and a miss on the wide half opens this menu.
          className="flex items-center border-l px-2.5 text-muted-foreground hover:bg-accent hover:text-foreground touch:min-w-[44px] touch:justify-center"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAddMenu({ x: Math.max(8, r.right - 200), y: r.bottom + 2 });
          }}
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      {addMenu && (
        <ContextMenu x={addMenu.x} y={addMenu.y} onClose={() => setAddMenu(null)}>
          <CommandMenuItem id="workspace.new" onClose={() => setAddMenu(null)} />
          <CommandMenuItem
            id="workspace.attach"
            hint="Your folder's .md files become the workspace's notes"
            onClose={() => setAddMenu(null)}
          />
        </ContextMenu>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem
            id="workspace.rename"
            target={{ kind: "workspace", id: menu.id }}
            onClose={() => setMenu(null)}
          />
          <CommandMenuItem
            id="workspace.icon"
            target={{ kind: "workspace", id: menu.id }}
            onClose={() => setMenu(null)}
          />
          <MenuDivider />
          <CommandMenuItem
            id="workspace.remove"
            hint={
              workspaceKind(state.workspaces.find((w) => w.id === menu.id)?.folder ?? "") === "external"
                ? "The folder and its notes stay where they are"
                : "Recoverable from Trash for 30 days"
            }
            target={{ kind: "workspace", id: menu.id }}
            onClose={() => setMenu(null)}
          />
        </ContextMenu>
      )}

      {pickingId && pickAnchor && (
        <IconPicker
          anchor={pickAnchor}
          current={state.workspaces.find((w) => w.id === pickingId)?.symbol ?? ""}
          onPick={(symbol) => dispatch({ type: "setWorkspaceIcon", id: pickingId, symbol })}
          onClose={() => setPickingId(null)}
        />
      )}

    </>
  );
}

// The insertion caret shown between rows while a drag hovers the strip.
function DropMarker() {
  return <div className="mx-1 my-0.5 h-0.5 rounded bg-primary" />;
}

function WorkspaceRow({
  ws,
  selected,
  renaming,
  canClose,
  hint,
  rowProps,
  onSelect,
  onBeginRename,
  onEndRename,
  onRename,
  onRemove,
  onDragStart,
  onDragEnd,
  dropping,
  onNoteDragOver,
  onNoteDragLeave,
  onDropNote,
  onContextMenu,
}: {
  ws: Workspace;
  selected: boolean;
  renaming: boolean;
  canClose: boolean;
  hint: number | null;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onSelect: () => void;
  onBeginRename: () => void;
  onEndRename: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  // The row as a drop target for a note dragged out of the browser. It claims
  // the drop only for a Ledge note (NOTE_DRAG), and not on the selected row:
  // the browser lists that workspace, so the note is already here.
  dropping: boolean;
  onNoteDragOver: () => void;
  onNoteDragLeave: () => void;
  onDropNote: (path: string) => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const press = useRowMenu(onContextMenu, onSelect);
  const Icon = iconFor(ws.symbol);
  // The hover button says what ⌫ does to this row: Delete Workspace with a
  // trash can, or Remove from Ledge with a cross for an attached folder.
  const removeTitle = useCommandTitle("workspace.remove", { kind: "workspace", id: ws.id });
  const RemoveIcon = workspaceKind(ws.folder) === "external" ? X : Trash2;
  const tabs = countTabs(ws.root);
  const panes = leafIds(ws.root).length;
  const summary = `${tabs} ${tabs === 1 ? "tab" : "tabs"}, ${panes} ${panes === 1 ? "pane" : "panes"}`;

  return (
    <div
      data-ws
      {...rowProps}
      {...targetAttrs({ kind: "workspace", id: ws.id })}
      {...press}
      // The row is not draggable while its rename field is up, so the pointer
      // can reach that field.
      draggable={!renaming}
      className={cn(
        // The 44px touch minimum matches the one in NoteBrowser's ROW_CLASS:
        // both are stacked rows with no gap to the row above
        // (interactions.md §1a).
        "group relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]",
        selected ? "bg-accent" : "hover:bg-accent/50",
        dropping && "bg-accent ring-1 ring-ring",
      )}
      onDoubleClick={onBeginRename}
      onDragStart={(e) => {
        // Firefox refuses to start a drag unless some data is set.
        e.dataTransfer.setData("text/plain", ws.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      // The strip's own handlers above reorder workspaces and ignore a drag
      // that is not one (draggingWs). A note's drag stops here, so the strip
      // never sees it as a reorder.
      onDragOver={(e) => {
        if (selected || !e.dataTransfer.types.includes(NOTE_DRAG)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        onNoteDragOver();
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes(NOTE_DRAG)) onNoteDragLeave();
      }}
      onDrop={(e) => {
        if (selected || !e.dataTransfer.types.includes(NOTE_DRAG)) return;
        e.preventDefault();
        e.stopPropagation();
        const path = e.dataTransfer.getData(NOTE_DRAG);
        if (path) onDropNote(path);
        else onNoteDragLeave();
      }}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <RenameField initial={ws.name} onCommit={onRename} onDone={onEndRename} />
        ) : (
          <div className="truncate text-sm leading-tight">{ws.name}</div>
        )}
        <div className="truncate text-[11px] leading-tight text-muted-foreground">{summary}</div>
      </div>
      {canClose && (
        <button
          // Absent, not invisible, on a client with no hover, the way the tab
          // strip's ✕ is (PaneTree.tsx). The same verb is in this row's
          // context menu.
          className="hidden size-5 shrink-0 items-center justify-center rounded opacity-0 hover:bg-background group-hover:opacity-100 hoverable:flex"
          title={`${removeTitle} (${keyChip("workspace.remove")})`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <RemoveIcon className="size-3.5" />
        </button>
      )}
      {hint != null && (
        <span className="pointer-events-none absolute right-1.5 top-1 rounded bg-foreground/10 px-1 text-[10px] font-medium leading-tight text-foreground/80">
          {jumpBadge(workspaceSelectKey(hint))}
        </span>
      )}
    </div>
  );
}

// --- trash -----------------------------------------------------------------

// Deleted workspaces, collapsed by default, between the strip and its New
// Workspace button: the note browser's Trash section one register up. It
// renders nothing while the trash is empty. The list is the server's
// (workspace/channel.ts), read when the strip mounts and when the window
// regains focus, since another client can delete one too.
function WorkspaceTrashSection() {
  const { dispatch } = useWorkspace();
  const items = useTrashedWorkspaces();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<TrashedWorkspace | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const nav = useListNav();

  const restore = (id: string) => {
    void restoreDeletedWorkspace(id, dispatch).then((err) => {
      if (err) uiHooks.showError?.(err);
    });
  };

  const deleteForever = (id: string) => {
    setDeleting(null);
    void deleteDeletedWorkspace(id).then((err) => {
      if (err) uiHooks.showError?.(err);
    });
  };

  const hooks = useRef({ restore });
  hooks.current = { restore };
  useEffect(() => {
    configureUi({
      restoreTrashedWorkspace: (id) => hooks.current.restore(id),
      confirmDeleteTrashedWorkspace: (item) => setDeleting(item),
    });
    void refreshTrashedWorkspaces();
    const onFocus = () => void refreshTrashedWorkspaces();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (open) setNow(Date.now());
  }, [open, items]);

  if (items.length === 0 && !deleting) return null;

  return (
    <div className="border-t" data-testid="workspace-trash">
      {/* 44 points on touch, for the note Trash header's reason: it sits just
          above the New Workspace button, so a miss creates a workspace. */}
      <button
        className="flex w-full items-center gap-1 px-3 py-1.5 text-left touch:min-h-[44px]"
        onClick={() => setOpen((o) => !o)}
        title="Deleted workspaces, kept in ~/.ledge/.ledge-trash"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Trash</span>
        <span className="text-[10px] text-muted-foreground/70">{items.length}</span>
      </button>

      {open && (
        <div {...nav.containerProps} className="max-h-40 overflow-y-auto px-1.5 pb-1.5">
          {items.map((item, i) => (
            <TrashedWorkspaceRow
              key={item.id}
              item={item}
              now={now}
              rowProps={nav.rowProps(item.id, i)}
              onRestore={() => restore(item.id)}
              onContextMenu={(x, y) => setMenu({ id: item.id, x, y })}
            />
          ))}
          <p className="px-2 pt-1.5 text-[10px] leading-snug text-muted-foreground/70">
            Deleted workspaces are removed for good after 30 days.
          </p>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem
            id="workspace.restore"
            target={{ kind: "trashedWorkspace", id: menu.id }}
            onClose={() => setMenu(null)}
          />
          <CommandMenuItem
            id="workspace.purge"
            target={{ kind: "trashedWorkspace", id: menu.id }}
            onClose={() => setMenu(null)}
            hint="Removes the folder and everything in it from disk. Cannot be undone."
          />
        </ContextMenu>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}” permanently?`}
          body={`${
            deleting.notes === 1 ? "Its 1 note" : `Its ${deleting.notes} notes`
          }, and everything else in its folder, will be removed from disk. This cannot be undone.`}
          confirmLabel="Delete Permanently"
          onConfirm={() => deleteForever(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function TrashedWorkspaceRow({
  item,
  now,
  rowProps,
  onRestore,
  onContextMenu,
}: {
  item: TrashedWorkspace;
  now: number;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onRestore: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { exec } = useCommands();
  const press = useRowMenu(onContextMenu);
  const Icon = iconFor(item.symbol);
  return (
    <div
      {...rowProps}
      {...targetAttrs({ kind: "trashedWorkspace", id: item.id })}
      {...press}
      className="group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring hoverable:min-h-8 touch:min-h-[44px]"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 flex-1 truncate text-[13px] leading-tight text-muted-foreground">{item.name}</div>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60 group-hover:hidden">
        {agoLabel(item.deletedAt, now)}
      </span>
      {/* The note trash row's two hover verbs: Restore first, Delete
          Permanently at the edge, which confirms (interactions.md §4). */}
      <button
        className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground group-hover:flex"
        title={tooltip("workspace.restore")}
        onClick={onRestore}
      >
        <RotateCcw className="size-3" />
      </button>
      <button
        className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:flex"
        title={tooltip("workspace.purge")}
        onClick={() => exec("workspace.purge", { kind: "trashedWorkspace", id: item.id })}
      >
        <Trash2 className="size-3" />
      </button>
    </div>
  );
}
