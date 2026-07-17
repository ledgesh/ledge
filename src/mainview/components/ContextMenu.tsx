// A small floating menu anchored at (x, y). Closes on any outside pointer press,
// Escape (via the modal layer stack), scroll, or window blur. We render our own
// instead of the native WebView menu (which offers only debug items like
// Reload / Inspect Element, suppressed app-wide in App.tsx). Items are usually
// CommandMenuItem (commands/CommandMenuItem.tsx), which renders straight from
// the command registry.
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { pushLayer } from "@/commands/layers";

export function ContextMenu({
  x,
  y,
  onClose,
  width = 200,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  // Wider for menus whose items are values rather than verbs (the host
  // picker's ssh destinations); the default fits every command menu.
  width?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node | null)) onClose();
    };
    // Escape goes through the shared layer stack, so a menu above a dialog
    // above the palette closes strictly top-first; while the menu is open the
    // window command dispatcher is suppressed.
    const offLayer = pushLayer("menu", onClose);
    // Capture so a press anywhere (including inside other handlers) closes first.
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      offLayer();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Keep the menu on-screen: flip above / nudge left when it would overflow.
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - 88);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width }}
      className="fixed z-50 rounded-md border bg-card p-1 text-card-foreground shadow-md"
    >
      {children}
    </div>
  );
}

export function MenuItem({
  onSelect,
  destructive,
  disabled,
  shortcut,
  title,
  children,
}: {
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  // Right-aligned key chip ("⌘W"); derive it from the registry, never hand-write.
  shortcut?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      role="menuitem"
      title={title}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : "hover:bg-accent hover:text-accent-foreground",
        disabled && "pointer-events-none opacity-45",
      )}
      onClick={onSelect}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {shortcut && (
        <span className="shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
          {shortcut}
        </span>
      )}
    </button>
  );
}
