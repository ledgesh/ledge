import { useRef } from "react";
import { cn } from "@/lib/utils";

// A thin draggable divider with two modes sharing one pointer-capture
// implementation (cursor/userSelect handling included):
//
// - px mode (`current` + `onResize`): reports a proposed absolute size as the
//   pointer moves; the parent clamps and stores it. Used for fixed-size panels
//   (sidebar width, workspace-strip height, terminal height). `invert` flips
//   the delta for a handle that sits on the far side of the panel it controls
//   (e.g. the terminal's handle is above it, so dragging up must grow it).
//
// - fraction mode (`containerRef` + `onResizeFraction`): reports the pointer's
//   position as a 0..1 fraction of the container, for ratio-based splits (the
//   pane divider); the reducer clamps the ratio.
//
// `axis`: "x" resizes width (drag horizontally), "y" height (drag vertically).
export function ResizeHandle({
  axis,
  current = 0,
  onResize,
  onResizeFraction,
  containerRef,
  invert = false,
  title,
  className,
}: {
  axis: "x" | "y";
  current?: number;
  onResize?: (proposed: number) => void;
  onResizeFraction?: (fraction: number) => void;
  containerRef?: React.RefObject<HTMLElement | null>;
  invert?: boolean;
  title?: string;
  className?: string;
}) {
  // The container rect is measured once per drag, not per move: the split's
  // own resize is what the drag causes, and re-measuring mid-drag would chase it.
  const rectRef = useRef<DOMRect | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startPos = axis === "x" ? e.clientX : e.clientY;
    const base = current;
    rectRef.current = containerRef?.current?.getBoundingClientRect() ?? null;
    const move = (ev: PointerEvent) => {
      const pos = axis === "x" ? ev.clientX : ev.clientY;
      if (onResizeFraction && rectRef.current) {
        const rect = rectRef.current;
        const frac = axis === "x" ? (pos - rect.left) / rect.width : (pos - rect.top) / rect.height;
        onResizeFraction(frac);
      } else if (onResize) {
        const delta = (pos - startPos) * (invert ? -1 : 1);
        onResize(base + delta);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      role="separator"
      title={title}
      onPointerDown={onPointerDown}
      className={cn(
        "shrink-0 bg-border transition-colors hover:bg-primary/40",
        axis === "x" ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize",
        className,
      )}
    />
  );
}
