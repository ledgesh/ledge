import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Columns2, FilePlus, Plus, Rows2, SquareX, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./store";
import { attachEditor, detachEditor, focusEditor } from "./editorPool";
import { leafIds, type LeafNode, type PaneNode, type SplitNode, type TabState } from "./tree";

// The tab being dragged, shared across every tab bar so a drop can name its
// source pane. Kept outside React state because it only ever needs to be read
// synchronously inside drag handlers; a re-render on drag start would be wasted.
let dragging: { fromPaneId: string; tabId: string } | null = null;

// Recursive renderer: a split node draws two children and a draggable divider; a
// leaf node draws a tab bar over a keep-alive editor host.
export function PaneTree({ node }: { node: PaneNode }) {
  return node.kind === "split" ? <SplitView node={node} /> : <LeafView leaf={node} />;
}

// --- split node ------------------------------------------------------------

function SplitView({ node }: { node: SplitNode }) {
  const { dispatch } = useWorkspace();
  const ref = useRef<HTMLDivElement>(null);
  const isRow = node.dir === "row";

  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const container = ref.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const frac = isRow ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      dispatch({ type: "setRatio", splitId: node.id, ratio: frac });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = isRow ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div ref={ref} className={cn("flex h-full w-full min-h-0 min-w-0", isRow ? "flex-row" : "flex-col")}>
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `0 0 ${node.ratio * 100}%` }}
      >
        <PaneTree node={node.children[0]} />
      </div>
      <div
        onPointerDown={onDividerDown}
        className={cn(
          "shrink-0 bg-border transition-colors hover:bg-primary/40",
          isRow ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize",
        )}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <PaneTree node={node.children[1]} />
      </div>
    </div>
  );
}

// --- leaf node -------------------------------------------------------------

function LeafView({ leaf }: { leaf: LeafNode }) {
  const { dispatch, selected } = useWorkspace();
  const focused = selected.focusedPaneId === leaf.id;

  return (
    <div
      className="flex h-full w-full min-h-0 min-w-0 flex-col bg-background"
      onMouseDownCapture={() => dispatch({ type: "focusPane", paneId: leaf.id })}
    >
      <TabBar leaf={leaf} focused={focused} />
      <div className={cn("relative min-h-0 flex-1 transition-opacity", !focused && "opacity-45")}>
        <PaneBody leaf={leaf} focused={focused} />
      </div>
    </div>
  );
}

// The editor host area. A single container into which the active tab's pooled
// editor is parented; switching tabs re-parents a different (already-alive)
// editor here. An empty pane shows a placeholder instead.
function PaneBody({ leaf, focused }: { leaf: LeafNode; focused: boolean }) {
  const { dispatch } = useWorkspace();
  const hostRef = useRef<HTMLDivElement>(null);
  const active = leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? null;
  const docId = active?.docId ?? null;

  useLayoutEffect(() => {
    const container = hostRef.current;
    if (!container || !active) return;
    attachEditor(container, active.docId, active.seed);
    return () => detachEditor(active.docId);
    // Re-parent only when the active doc changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Put the caret in this editor when its pane gains focus or its tab changes.
  useLayoutEffect(() => {
    if (focused && docId) focusEditor(docId);
  }, [focused, docId]);

  if (!active) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <span className="text-sm">No open notes</span>
        <button
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
          onClick={() => dispatch({ type: "newTab", paneId: leaf.id })}
        >
          <FilePlus className="size-3.5" /> New Note
        </button>
      </div>
    );
  }
  return <div ref={hostRef} className="h-full w-full" />;
}

// --- tab bar ---------------------------------------------------------------

function TabBar({ leaf, focused }: { leaf: LeafNode; focused: boolean }) {
  const { dispatch, selected } = useWorkspace();
  const canClosePane = leafIds(selected.root).length > 1;
  const stripRef = useRef<HTMLDivElement>(null);
  // Where an in-flight drop would land, as an index into the current tab list.
  // Null when no tab is hovering this bar.
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // The slot the cursor is over: the count of tabs whose horizontal midpoint sits
  // left of it (0..tabs.length). Measured off the live DOM so it tracks the real
  // rendered widths, including truncated titles and the scroll offset.
  const slotAt = (clientX: number): number => {
    const strip = stripRef.current;
    if (!strip) return leaf.tabs.length;
    const items = strip.querySelectorAll<HTMLElement>("[data-tab]");
    let i = 0;
    for (const item of items) {
      const r = item.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
      i += 1;
    }
    return items.length;
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!dragging) return;
    e.preventDefault(); // allow the drop
    e.dataTransfer.dropEffect = "move";
    setDropIndex(slotAt(e.clientX));
  };

  const onDrop = (e: React.DragEvent) => {
    if (!dragging) return;
    e.preventDefault();
    dispatch({
      type: "moveTab",
      fromPaneId: dragging.fromPaneId,
      tabId: dragging.tabId,
      toPaneId: leaf.id,
      toIndex: slotAt(e.clientX),
    });
    dragging = null;
    setDropIndex(null);
  };

  // Only clear the marker when the pointer truly leaves the strip, not when it
  // crosses between child tabs (those fire dragleave on the parent too).
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null);
  };

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b bg-muted/30">
      <div
        ref={stripRef}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
      >
        {leaf.tabs.map((tab, i) => (
          <Fragment key={tab.id}>
            {dropIndex === i && <DropMarker />}
            <TabItem leaf={leaf} tab={tab} paneFocused={focused} />
          </Fragment>
        ))}
        {dropIndex === leaf.tabs.length && <DropMarker />}
        <button
          className="flex w-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          title="New tab (⌘T)"
          onClick={() => dispatch({ type: "newTab", paneId: leaf.id })}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l px-1">
        <PaneAction
          title="Split right (⌘D)"
          onClick={() => dispatch({ type: "splitPane", dir: "row", paneId: leaf.id })}
        >
          <Columns2 className="size-3.5" />
        </PaneAction>
        <PaneAction
          title="Split down (⇧⌘D)"
          onClick={() => dispatch({ type: "splitPane", dir: "col", paneId: leaf.id })}
        >
          <Rows2 className="size-3.5" />
        </PaneAction>
        {canClosePane && (
          <PaneAction
            title="Close pane (⇧⌘W)"
            onClick={() => dispatch({ type: "closePane", paneId: leaf.id })}
          >
            <SquareX className="size-3.5" />
          </PaneAction>
        )}
      </div>
    </div>
  );
}

// The insertion caret shown between tabs while a drag hovers the bar.
function DropMarker() {
  return <div className="w-0.5 shrink-0 self-stretch bg-primary" />;
}

function PaneAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TabItem({
  leaf,
  tab,
  paneFocused,
}: {
  leaf: LeafNode;
  tab: TabState;
  paneFocused: boolean;
}) {
  const { dispatch } = useWorkspace();
  const active = leaf.activeTabId === tab.id;
  const [dragged, setDragged] = useState(false);
  return (
    <div
      data-tab
      draggable
      className={cn(
        "group flex min-w-0 max-w-[180px] shrink-0 cursor-default items-center gap-1.5 border-r px-2.5 text-xs",
        active
          ? cn("bg-background", paneFocused ? "text-foreground" : "text-muted-foreground")
          : "text-muted-foreground hover:bg-background/60",
        dragged && "opacity-40",
      )}
      onClick={() => dispatch({ type: "selectTab", paneId: leaf.id, tabId: tab.id })}
      onDragStart={(e) => {
        dragging = { fromPaneId: leaf.id, tabId: tab.id };
        // Firefox refuses to start a drag unless some data is set.
        e.dataTransfer.setData("text/plain", tab.id);
        e.dataTransfer.effectAllowed = "move";
        setDragged(true);
      }}
      onDragEnd={() => {
        dragging = null;
        setDragged(false);
      }}
    >
      <span className="truncate">{tab.title}</span>
      <button
        className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-accent group-hover:opacity-100"
        title="Close tab (⌘W)"
        onClick={(e) => {
          e.stopPropagation();
          dispatch({ type: "closeTab", paneId: leaf.id, tabId: tab.id });
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
