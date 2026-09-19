// The destination chooser behind Move to Workspace… (interactions.md §3): the
// strip's workspaces minus the one the note is in. A list and not a filter
// field like FolderPicker, since the strip holds a handful of rows and every
// one exists. ↑/↓ move the highlight, Enter picks, Escape cancels. A pick
// returns the workspace's folder, a root handle Bun issued and re-checks.
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { pushLayer } from "@/commands/layers";
import { iconFor } from "@/workspace/icons";
import type { Workspace } from "@/workspace/tree";

export function WorkspacePicker({
  title,
  description,
  workspaces,
  onPick,
  onCancel,
}: {
  title: string;
  description: string;
  workspaces: readonly Workspace[];
  onPick: (folder: string) => void;
  onCancel: () => void;
}) {
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const index = Math.min(at, Math.max(workspaces.length - 1, 0));

  // The list takes focus on open, so the arrows work without a click.
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  useEffect(() => pushLayer("dialog", onCancel), [onCancel]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (workspaces.length === 0) return;
      const next = e.key === "ArrowDown" ? index + 1 : index - 1;
      setAt((next + workspaces.length) % workspaces.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const ws = workspaces[index];
      if (ws) onPick(ws.folder);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[60vh] w-full max-w-sm flex-col rounded-lg border bg-background p-4 shadow-xl"
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">{description}</p>
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          data-testid="workspace-picker-list"
          className="mt-3 min-h-0 flex-1 overflow-y-auto outline-none"
        >
          {workspaces.map((ws, i) => {
            const Icon = iconFor(ws.symbol);
            return (
              <button
                key={ws.id}
                data-active={i === index}
                data-testid="workspace-picker-row"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left touch:min-h-[44px]",
                  i === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
                onMouseMove={() => setAt(i)}
                onClick={() => onPick(ws.folder)}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="block min-w-0 flex-1 truncate text-sm">{ws.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
