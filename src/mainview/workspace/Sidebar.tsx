import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Boxes, Folder, Inbox, Layers, Pencil, Plus, Terminal, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCmdHeld } from "@/lib/useCmdHeld";
import { useWorkspace } from "./store";
import { countTabs, leafIds, type Workspace } from "./tree";

// The vertical workspace strip. Workspaces stack and scroll down the side; each
// carries its own pane tree, so switching preserves every workspace's splits,
// tabs, and selection (the tree lives in the store, the editors in the pool).
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  inbox: Inbox,
  layers: Layers,
  boxes: Boxes,
  folder: Folder,
  terminal: Terminal,
};

// The workspace id being dragged, read synchronously inside drop handlers. Kept
// outside React state (like the tab drag in PaneTree) so drag start needs no
// re-render.
let draggingWs: string | null = null;

export function Sidebar() {
  const { state, dispatch } = useWorkspace();
  const cmdHeld = useCmdHeld();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The right-click menu: which workspace, and where to anchor it. Null when closed.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Where an in-flight drop would land, as an index into the workspace list.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
    <aside className="flex h-full w-full min-w-0 flex-col bg-muted/20">
      <div className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Workspaces
      </div>
      <div
        ref={listRef}
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
              onSelect={() => dispatch({ type: "selectWorkspace", id: ws.id })}
              onBeginRename={() => setRenamingId(ws.id)}
              onEndRename={() => setRenamingId(null)}
              onRename={(name) => dispatch({ type: "renameWorkspace", id: ws.id, name })}
              onClose={() => dispatch({ type: "closeWorkspace", id: ws.id })}
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
        onClick={() => dispatch({ type: "newWorkspace" })}
      >
        <Plus className="size-4" /> New Workspace
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            onSelect={() => {
              setRenamingId(menu.id);
              setMenu(null);
            }}
          >
            <Pencil className="size-3.5" /> Rename
          </MenuItem>
          {state.workspaces.length > 1 && (
            <MenuItem
              destructive
              onSelect={() => {
                dispatch({ type: "closeWorkspace", id: menu.id });
                setMenu(null);
              }}
            >
              <Trash2 className="size-3.5" /> Close workspace
            </MenuItem>
          )}
        </ContextMenu>
      )}
    </aside>
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
  onSelect: () => void;
  onBeginRename: () => void;
  onEndRename: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const Icon = ICONS[ws.symbol] ?? Layers;
  const tabs = countTabs(ws.root);
  const panes = leafIds(ws.root).length;
  const summary = `${tabs} ${tabs === 1 ? "tab" : "tabs"}, ${panes} ${panes === 1 ? "pane" : "panes"}`;

  return (
    <div
      data-ws
      // Don't arm the drag while renaming, or the pointer can't reach the input.
      draggable={!renaming}
      className={cn(
        "group relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
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
          title="Close workspace"
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

function RenameField({
  initial,
  onCommit,
  onDone,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    onCommit(draft);
    onDone();
  };

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") onDone();
      }}
      className="w-full rounded border bg-background px-1 py-0.5 text-sm outline-none"
    />
  );
}

// A small floating menu anchored at (x, y). Closes on any outside pointer press,
// Escape, scroll, or window blur. We render our own instead of the native
// WebView menu (which offers only debug items like Reload / Inspect Element,
// suppressed app-wide in App.tsx).
function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node | null)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture so a press anywhere (including inside other handlers) closes first.
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Keep the menu on-screen: flip above / nudge left when it would overflow.
  const W = 176;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - 88);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width: W }}
      className="fixed z-50 rounded-md border bg-card p-1 text-card-foreground shadow-md"
    >
      {children}
    </div>
  );
}

function MenuItem({
  onSelect,
  destructive,
  children,
}: {
  onSelect: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      role="menuitem"
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : "hover:bg-accent hover:text-accent-foreground",
      )}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
