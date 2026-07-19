// The workspace icon picker: a grid popover anchored to the workspace's row in
// the strip. Reached from the row's context menu, the `i` row verb, and the
// palette (interactions.md §1) — which is why it anchors to the row rather
// than to a click point: the palette has no click point, and the popover has to
// appear next to the thing it is about either way.
//
// Choosing is the whole interaction, so a click commits and closes. There is no
// Cancel: the choice is one dispatch and undone by picking again.
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
  // The row the picker belongs to. Measured on open, so a scroll or a resize
  // closes rather than leaving the popover pointing at nothing.
  anchor: HTMLElement;
  current: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Place it before paint: measure the popover's own height so it can flip
  // above a row near the bottom of the strip instead of hanging off-screen.
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
    // Escape goes through the shared layer stack like every other modal, so a
    // picker opened from the palette closes strictly before it.
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

  // Open on the current icon: the picker's job is usually to change a choice,
  // so the keyboard should start where the choice is.
  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const cells = grid.querySelectorAll<HTMLButtonElement>("button");
    const i = WORKSPACE_ICONS.findIndex((ic) => ic.key === current);
    (cells[Math.max(0, i)] ?? cells[0])?.focus();
  }, [current]);

  // Arrow keys walk the grid. Tab order alone would make you cross 24 buttons
  // to reach a neighbour one row down.
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
        // Hidden for the measuring pass only: one frame at (0,0) reads as a flash.
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
            "flex size-8 items-center justify-center rounded outline-none",
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
