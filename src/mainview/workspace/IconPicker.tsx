// The workspace icon picker: a grid popover anchored to the workspace's row in
// the strip. Opened from the row's context menu, the `i` row verb, or the
// palette (interactions.md §1). It anchors to the row because a palette entry
// has no click point, and because the popover should sit next to the workspace
// it is about however it was opened. A click picks the icon and closes. There
// is no Cancel: the pick is one `setWorkspaceIcon` dispatch, undone by picking
// again.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { pushLayer } from "@/commands/layers";
import { WORKSPACE_ICONS } from "./icons";

const COLS = 6;
const W = 224;

export function IconPicker({
  anchor,
  current,
  onPick,
  onClose,
}: {
  // The row the picker belongs to. Its position is measured once, when the
  // picker opens, so a scroll or a resize closes the picker instead of leaving
  // it misplaced.
  anchor: HTMLElement;
  current: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position the popover before paint. Its own height decides whether it opens
  // below the row or flips above it, so a picker opened from a row near the
  // bottom of the strip does not hang off the screen.
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 0;
    const below = r.bottom + 4;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
      top: below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below,
    });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node | null)) onClose();
    };
    // Escape goes through the shared layer stack (interactions.md §6), not one
    // of its own. The stack is LIFO, so the picker takes Escape ahead of any
    // layer opened before it.
    const offLayer = pushLayer("menu", onClose);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      offLayer();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // The picker focuses the workspace's current icon, so the arrow keys below
  // start from the existing choice. A `current` that names no icon in the
  // catalog falls back to the first cell.
  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const cells = grid.querySelectorAll<HTMLButtonElement>("button");
    const i = WORKSPACE_ICONS.findIndex((ic) => ic.key === current);
    (cells[Math.max(0, i)] ?? cells[0])?.focus();
  }, [current]);

  // Arrow keys walk the grid: left and right by one cell, up and down by a
  // whole row. Tab order alone steps one cell at a time through all 24
  // buttons.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const delta =
      e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? COLS : e.key === "ArrowUp" ? -COLS : 0;
    if (!delta) return;
    e.preventDefault();
    const cells = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    cells[Math.max(0, Math.min(at + delta, cells.length - 1))]?.focus();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Workspace icon"
      onKeyDown={onKeyDown}
      style={{
        width: W,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // Hidden for the measuring pass only. The layout effect above reads
        // this element's height off the DOM to decide whether to flip above
        // the row, so the popover has to render before pos exists.
        visibility: pos ? "visible" : "hidden",
      }}
      className="fixed z-50 grid grid-cols-6 gap-1 rounded-md border bg-card p-2 text-card-foreground shadow-md"
    >
      {WORKSPACE_ICONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          title={label}
          aria-label={label}
          aria-pressed={key === current}
          className={cn(
            // Cells grow to 44 points on touch (interactions.md §1a). At rest
            // they are 28 points three points apart, one of the tight targets
            // that section measured. Every neighbour sets a different icon on
            // the same workspace. `W` above is a fixed 224 and does not grow
            // on touch.
            "flex size-8 items-center justify-center rounded outline-none touch:size-[44px]",
            key === current
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring",
          )}
          onClick={() => {
            onPick(key);
            onClose();
          }}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
