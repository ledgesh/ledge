import { useEffect, useRef, useState, type ComponentType } from "react";
import { Boxes, Folder, Inbox, Layers, Plus, Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";
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

export function Sidebar() {
  const { state, dispatch } = useWorkspace();
  const [renamingId, setRenamingId] = useState<string | null>(null);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/20">
      <div className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Workspaces
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {state.workspaces.map((ws) => (
          <WorkspaceRow
            key={ws.id}
            ws={ws}
            selected={ws.id === state.selectedId}
            renaming={renamingId === ws.id}
            canClose={state.workspaces.length > 1}
            onSelect={() => dispatch({ type: "selectWorkspace", id: ws.id })}
            onBeginRename={() => setRenamingId(ws.id)}
            onEndRename={() => setRenamingId(null)}
            onRename={(name) => dispatch({ type: "renameWorkspace", id: ws.id, name })}
            onClose={() => dispatch({ type: "closeWorkspace", id: ws.id })}
          />
        ))}
      </div>
      <button
        className="flex items-center gap-2 border-t px-3.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => dispatch({ type: "newWorkspace" })}
      >
        <Plus className="size-4" /> New Workspace
      </button>
    </aside>
  );
}

function WorkspaceRow({
  ws,
  selected,
  renaming,
  canClose,
  onSelect,
  onBeginRename,
  onEndRename,
  onRename,
  onClose,
}: {
  ws: Workspace;
  selected: boolean;
  renaming: boolean;
  canClose: boolean;
  onSelect: () => void;
  onBeginRename: () => void;
  onEndRename: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const Icon = ICONS[ws.symbol] ?? Layers;
  const tabs = countTabs(ws.root);
  const panes = leafIds(ws.root).length;
  const summary = `${tabs} ${tabs === 1 ? "tab" : "tabs"}, ${panes} ${panes === 1 ? "pane" : "panes"}`;

  return (
    <div
      className={cn(
        "group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
      onClick={onSelect}
      onDoubleClick={onBeginRename}
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
