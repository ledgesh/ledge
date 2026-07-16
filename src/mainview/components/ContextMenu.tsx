// A small floating menu anchored at (x, y). Closes on any outside pointer press,
// Escape, scroll, or window blur. We render our own instead of the native WebView
// menu (which offers only debug items like Reload / Inspect Element, suppressed
// app-wide in App.tsx). Shared by the workspace strip and the note list.
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ContextMenu({
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

export function MenuItem({
  onSelect,
  destructive,
  title,
  children,
}: {
  onSelect: () => void;
  destructive?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      role="menuitem"
      title={title}
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
