import { useRef } from "react";
import { cn } from "@/lib/utils";

// A thin draggable divider with two modes sharing one drag implementation
// (it sets the body cursor and blocks text selection for the drag either way).
// `axis`: "x" resizes width (drag horizontally), "y" height (drag vertically).
//
// - px mode (`current` + `onResize`) reports a proposed absolute size as the
//   pointer moves, and the parent clamps and stores it. The sidebar and the
//   right panel use it for their width, the workspace strip and the terminal
//   for their height. `invert` flips the delta for a handle that sits on the
//   far side of the panel it controls. The terminal's handle is above the
//   terminal, so dragging up grows it.
//
// - fraction mode (`containerRef` + `onResizeFraction`) reports the pointer's
//   position as a 0..1 fraction of the container, for ratio-based splits (the
//   pane divider). The reducer clamps the ratio.
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
  // The container rect that fraction mode divides by. It is measured once at
  // pointerdown and reused for every move of that drag.
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
