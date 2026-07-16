import { cn } from "@/lib/utils";

// A thin draggable divider that reports a proposed absolute size (in px) as the
// pointer moves; the parent clamps and stores it. Same pointer-capture pattern as
// the pane-split divider in PaneTree, but for fixed-size panels (sidebar width,
// terminal height) rather than a ratio.
//
// `axis`: "x" resizes width (drag horizontally), "y" resizes height (drag
// vertically). `invert` flips the delta for a handle that sits on the far side of
// the panel it controls (e.g. the terminal's handle is above it, so dragging up
// must grow it). `current` is the panel's size at drag start; each move reports
// `current + delta` unclamped.
export function ResizeHandle({
  axis,
  current,
  onResize,
  invert = false,
  title,
  className,
}: {
  axis: "x" | "y";
  current: number;
  onResize: (proposed: number) => void;
  invert?: boolean;
  title?: string;
  className?: string;
}) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startPos = axis === "x" ? e.clientX : e.clientY;
    const base = current;
    const move = (ev: PointerEvent) => {
      const pos = axis === "x" ? ev.clientX : ev.clientY;
      const delta = (pos - startPos) * (invert ? -1 : 1);
      onResize(base + delta);
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
