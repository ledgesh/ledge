import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCmdHeld } from "@/lib/useCmdHeld";
import { useListNav } from "@/lib/useListNav";
import { ResizeHandle } from "@/components/ResizeHandle";
import { ContextMenu } from "@/components/ContextMenu";
import { RenameField } from "@/components/RenameField";
import { NoteBrowser } from "@/notes/NoteBrowser";
import { useCommands } from "@/commands/CommandProvider";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { configureUi } from "@/commands/glue";
import { tooltip } from "@/commands/format";
import { targetAttrs } from "@/commands/target";
import { useWorkspace } from "./store";
import { IconPicker } from "./IconPicker";
import { iconFor } from "./icons";
import { countTabs, leafIds, type Workspace } from "./tree";

// How the sidebar splits between its two sections, and the room each keeps when
// the divider is dragged to an extreme.
const STRIP_DEFAULT = 200;
const STRIP_MIN = 88;
const NOTES_MIN = 120;

// The sidebar: the workspace strip on top, the note list below, divided by a
// draggable handle. Notes are global to ~/.ledge while workspaces are collections
// of tabs, so the two are independent lists and both stay visible at once.
export function Sidebar() {
  const [stripHeight, setStripHeight] = useState(STRIP_DEFAULT);
  const ref = useRef<HTMLDivElement>(null);

  // Clamp against the live height so neither section can be collapsed away, the
  // same measure-the-container rule App uses for the terminal drawer.
  const resize = useCallback((h: number) => {
    const avail = ref.current?.clientHeight ?? window.innerHeight;
    setStripHeight(Math.max(STRIP_MIN, Math.min(h, avail - NOTES_MIN)));
  }, []);

  return (
    <aside ref={ref} className="flex h-full w-full min-w-0 flex-col bg-muted/20">
      <div style={{ height: stripHeight }} className="flex min-h-0 shrink-0 flex-col">
        <WorkspaceStrip />
      </div>
      <ResizeHandle axis="y" current={stripHeight} onResize={resize} title="Drag to resize" />
      <NoteBrowser />
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

function WorkspaceStrip() {
  const { state, dispatch } = useWorkspace();
  const { exec } = useCommands();
  const cmdHeld = useCmdHeld();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The right-click menu: which workspace, and where to anchor it. Null when closed.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // The workspace whose icon is being picked, and the row the popover hangs off.
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [pickAnchor, setPickAnchor] = useState<HTMLElement | null>(null);

  // The strip owns the inline-rename state and the icon picker, so it registers
  // the hooks those commands (menu item, row verb, palette entry) reach it
  // through.
  useEffect(() => {
    configureUi({ beginRenameWorkspace: setRenamingId, pickWorkspaceIcon: setPickingId });
  }, []);

  // Where an in-flight drop would land, as an index into the workspace list.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const nav = useListNav();
  const listRef = nav.containerProps.ref;

  // The picker anchors to a row, and only the DOM knows where the rows are. A
  // workspace with no row on screen has nothing to anchor to, so the open is
  // dropped rather than left as an invisible popover holding the Escape layer.
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
  // above it (0..workspaces.length). Measured off the live DOM so it tracks the
  // real rendered heights and scroll offset.
  const slotAt = (clientY: number): number => {
    const list = listRef.current;
    if (!list) return state.workspaces.length;
    const items = list.querySelectorAll<HTMLElement>("[data-ws]");
    let i = 0;
    for (const item of items) {
      const r = item.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
      i += 1;
    }
    return items.length;
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
    dispatch({ type: "moveWorkspace", id: draggingWs, toIndex: slotAt(e.clientY) });
    draggingWs = null;
    setDropIndex(null);
  };

  // Only clear the marker when the pointer truly leaves the list, not when it
  // crosses between rows (those fire dragleave on the parent too).
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
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
      >
        {state.workspaces.map((ws, i) => (
          <div key={ws.id}>
            {dropIndex === i && <DropMarker />}
            <WorkspaceRow
              ws={ws}
              selected={ws.id === state.selectedId}
              renaming={renamingId === ws.id}
              canClose={state.workspaces.length > 1}
              hint={cmdHeld && i < 9 ? i + 1 : null}
              rowProps={nav.rowProps(ws.id, i)}
              onSelect={() => exec("workspace.open", { kind: "workspace", id: ws.id })}
              onBeginRename={() => setRenamingId(ws.id)}
              onEndRename={() => setRenamingId(null)}
              onRename={(name) => dispatch({ type: "renameWorkspace", id: ws.id, name })}
              onClose={() => exec("workspace.close", { kind: "workspace", id: ws.id })}
              onDragStart={() => (draggingWs = ws.id)}
              onDragEnd={() => {
                draggingWs = null;
                setDropIndex(null);
              }}
              onContextMenu={(x, y) => {
                dispatch({ type: "selectWorkspace", id: ws.id });
                setMenu({ id: ws.id, x, y });
              }}
            />
          </div>
        ))}
        {dropIndex === state.workspaces.length && <DropMarker />}
      </div>
      <button
        className="flex items-center gap-2 border-t px-3.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        title={tooltip("workspace.new")}
        onClick={() => exec("workspace.new")}
      >
        <Plus className="size-4" /> New Workspace
      </button>

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
          <CommandMenuItem
            id="workspace.close"
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
  onClose,
  onDragStart,
  onDragEnd,
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
  onClose: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const Icon = iconFor(ws.symbol);
  const tabs = countTabs(ws.root);
  const panes = leafIds(ws.root).length;
  const summary = `${tabs} ${tabs === 1 ? "tab" : "tabs"}, ${panes} ${panes === 1 ? "pane" : "panes"}`;

  return (
    <div
      data-ws
      {...rowProps}
      {...targetAttrs({ kind: "workspace", id: ws.id })}
      // Don't arm the drag while renaming, or the pointer can't reach the input.
      draggable={!renaming}
      className={cn(
        "group relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
      onClick={onSelect}
      onDoubleClick={onBeginRename}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onDragStart={(e) => {
        // Firefox refuses to start a drag unless some data is set.
        e.dataTransfer.setData("text/plain", ws.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
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
          className="flex size-5 shrink-0 items-center justify-center rounded opacity-0 hover:bg-background group-hover:opacity-100"
          title={tooltip("workspace.close")}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
      {hint != null && (
        <span className="pointer-events-none absolute right-1.5 top-1 rounded bg-foreground/10 px-1 text-[10px] font-medium leading-tight text-foreground/80">
          ⌘{hint}
        </span>
      )}
    </div>
  );
}
