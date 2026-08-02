import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Columns2, FilePlus, Plus, Rows2, SquareX, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCmdHeld, useCtrlHeld } from "@/lib/useCmdHeld";
import { useRowMenu } from "@/lib/useRowMenu";
import { ContextMenu } from "@/components/ContextMenu";
import { ResizeHandle } from "@/components/ResizeHandle";
import { useCommands } from "@/commands/CommandProvider";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { tooltip } from "@/commands/format";
import { workspaceKind } from "./channel";
import { useWorkspace } from "./store";
import { attachEditor, detachEditor, focusEditor } from "./editorPool";
import { leafIds, type LeafNode, type PaneNode, type SplitNode, type TabState } from "./tree";
import { clippedEdges, wheelTravel } from "./tabStrip";

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

  return (
    <div ref={ref} className={cn("flex h-full w-full min-h-0 min-w-0", isRow ? "flex-row" : "flex-col")}>
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `0 0 ${node.ratio * 100}%` }}
      >
        <PaneTree node={node.children[0]} />
      </div>
      <ResizeHandle
        axis={isRow ? "x" : "y"}
        containerRef={ref}
        onResizeFraction={(frac) => dispatch({ type: "setRatio", splitId: node.id, ratio: frac })}
        title="Drag to resize split"
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
  const { dispatch, selected } = useWorkspace();
  const { exec } = useCommands();
  const hostRef = useRef<HTMLDivElement>(null);
  const active = leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? null;
  const docId = active?.docId ?? null;
  // PaneTree only ever renders the selected workspace, so the selected
  // workspace's folder IS this tab's folder — and it never changes for a
  // given docId (tabs stay in their workspace).
  const folder = selected.folder;

  useLayoutEffect(() => {
    const container = hostRef.current;
    if (!container || !active) return;
    attachEditor(container, active, folder, {
      // The note's file appeared (first save) or moved to follow its H1. Both reach
      // the tab the same way; only which action carries it differs, since a create
      // is identified by the docId that owns it and a move by the path it left.
      onFile: (note, prevPath) =>
        dispatch(
          prevPath === null
            ? { type: "noteCreated", docId: active.docId, folder, note }
            : { type: "noteRenamed", path: prevPath, note },
        ),
      // The heading changed. Not the same event as the file moving: a heading can
      // change without the slug doing so, and then only the label moves.
      onTitle: (label) => dispatch({ type: "noteTitled", docId: active.docId, label }),
    });
    return () => detachEditor(active.docId);
    // Re-parent only when the active doc changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Put the caret in this editor when its pane gains focus or its tab changes.
  //
  // Unless a list row is driving: opening a note from the sidebar changes this
  // pane's active tab, and yanking focus into the editor would take it right
  // back off the row the user is working — which is what the row verbs act on
  // (interactions.md §1 R5). Clicking a note shows it; clicking the
  // editor is what says you want to type in it.
  useLayoutEffect(() => {
    if (!focused || !docId) return;
    if (document.activeElement?.closest("[data-list-row]")) return;
    focusEditor(docId);
  }, [focused, docId]);

  if (!active) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <span className="text-sm">No open notes</span>
        {/* Not in the docs workspace: nothing creates there, and a button
            whose command is gated would be a dead affordance. */}
        {workspaceKind(folder) !== "docs" && (
          <button
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
            title={tooltip("note.new")}
            onClick={() => exec("note.new", { kind: "pane", paneId: leaf.id })}
          >
            <FilePlus className="size-3.5" /> New Note
          </button>
        )}
      </div>
    );
  }
  return <div ref={hostRef} className="h-full w-full" />;
}

// --- tab bar ---------------------------------------------------------------

function TabBar({ leaf, focused }: { leaf: LeafNode; focused: boolean }) {
  const { dispatch, selected } = useWorkspace();
  const { exec } = useCommands();
  // Tab quick-jump is Ctrl+number, but cmux shows the badge on either modifier.
  // Ctrl+number targets the FOCUSED pane, so only its tab bar gets badges (with
  // multiple tab groups, badging the others would be misleading).
  const cmdHeld = useCmdHeld();
  const ctrlHeld = useCtrlHeld();
  const badges = focused && (cmdHeld || ctrlHeld);
  const canClosePane = leafIds(selected.root).length > 1;
  const stripRef = useRef<HTMLDivElement>(null);
  // The right-click menu: which tab, and where to anchor it. Null when closed.
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  // Where an in-flight drop would land, as an index into the current tab list.
  // Null when no tab is hovering this bar.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Which edges of the strip are clipping tabs. The strip's scrollbar is
  // hidden (index.css .ledge-tabstrip), so the fade masks these drive are the
  // only sign that more tabs sit off an edge.
  const [clipped, setClipped] = useState({ left: false, right: false });

  const syncClipped = () => {
    const strip = stripRef.current;
    if (!strip) return;
    const next = clippedEdges(strip.scrollLeft, strip.clientWidth, strip.scrollWidth);
    setClipped((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
  };

  // Re-measure when the tab list changes and whenever the strip is resized —
  // the strip resizes with its pane, so one observer covers split drags and
  // window resizes both. Scrolling is handled by onScroll on the strip.
  useLayoutEffect(() => {
    syncClipped();
    const strip = stripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(syncClipped);
    observer.observe(strip);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaf.tabs]);

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
        className={cn(
          "ledge-tabstrip flex min-w-0 flex-1 items-stretch overflow-x-auto",
          clipped.left && "ledge-tabstrip-clip-l",
          clipped.right && "ledge-tabstrip-clip-r",
        )}
        onScroll={syncClipped}
        onWheel={(e) => {
          const travel = wheelTravel(e.deltaX, e.deltaY);
          if (travel) stripRef.current?.scrollBy({ left: travel });
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
      >
        {leaf.tabs.map((tab, i) => (
          <Fragment key={tab.id}>
            {dropIndex === i && <DropMarker />}
            <TabItem
              leaf={leaf}
              tab={tab}
              paneFocused={focused}
              hint={badges && i < 9 ? i + 1 : null}
              onContextMenu={(x, y) => setMenu({ tabId: tab.id, x, y })}
            />
          </Fragment>
        ))}
        {dropIndex === leaf.tabs.length && <DropMarker />}
        {/* The + is New Note; the docs workspace has no such thing. */}
        {workspaceKind(selected.folder) !== "docs" && (
          <button
            className="flex w-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            title={tooltip("note.new")}
            onClick={() => exec("note.new", { kind: "pane", paneId: leaf.id })}
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l px-1">
        <PaneAction
          title={tooltip("pane.splitRight")}
          onClick={() => exec("pane.splitRight", { kind: "pane", paneId: leaf.id })}
        >
          <Columns2 className="size-3.5" />
        </PaneAction>
        <PaneAction
          title={tooltip("pane.splitDown")}
          onClick={() => exec("pane.splitDown", { kind: "pane", paneId: leaf.id })}
        >
          <Rows2 className="size-3.5" />
        </PaneAction>
        {canClosePane && (
          <PaneAction
            title={tooltip("pane.close")}
            onClick={() => exec("pane.close", { kind: "pane", paneId: leaf.id })}
          >
            <SquareX className="size-3.5" />
          </PaneAction>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem
            id="tab.close"
            target={{ kind: "tab", paneId: leaf.id, tabId: menu.tabId }}
            onClose={() => setMenu(null)}
          />
          <CommandMenuItem
            id="tab.closeOthers"
            target={{ kind: "tab", paneId: leaf.id, tabId: menu.tabId }}
            onClose={() => setMenu(null)}
          />
          <CommandMenuItem
            id="pane.splitRight"
            target={{ kind: "pane", paneId: leaf.id }}
            onClose={() => setMenu(null)}
          />
          <CommandMenuItem
            id="pane.splitDown"
            target={{ kind: "pane", paneId: leaf.id }}
            onClose={() => setMenu(null)}
          />
        </ContextMenu>
      )}
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
  hint,
  onContextMenu,
}: {
  leaf: LeafNode;
  tab: TabState;
  paneFocused: boolean;
  hint: number | null;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { dispatch } = useWorkspace();
  const { exec } = useCommands();
  const active = leaf.activeTabId === tab.id;
  const [dragged, setDragged] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // A tab is a row for menu purposes (R6): right-click, or a finger held on
  // it, opens the same menu. That menu is where Close Tab and Close Others
  // live for anyone without ⌘W, which is every touch client.
  const press = useRowMenu(
    onContextMenu,
    () => dispatch({ type: "selectTab", paneId: leaf.id, tabId: tab.id }),
  );

  // Keep the active tab on screen. With the strip's scrollbar hidden, a ⌃Tab
  // or ⌃N jump to a clipped tab would otherwise switch to something invisible.
  useLayoutEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div
      ref={ref}
      data-tab
      {...press}
      draggable
      className={cn(
        "group relative flex min-w-0 max-w-[180px] shrink-0 cursor-default items-center gap-1.5 border-r px-2.5 text-xs",
        active
          ? cn("bg-background", paneFocused ? "text-foreground" : "text-muted-foreground")
          : "text-muted-foreground hover:bg-background/60",
        dragged && "opacity-40",
      )}
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
        title={tooltip("tab.close")}
        onClick={(e) => {
          e.stopPropagation();
          exec("tab.close", { kind: "tab", paneId: leaf.id, tabId: tab.id });
        }}
      >
        <X className="size-3" />
      </button>
      {hint != null && (
        <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 rounded bg-foreground/10 px-1 text-[10px] font-medium leading-tight text-foreground/80">
          ^{hint}
        </span>
      )}
    </div>
  );
}
