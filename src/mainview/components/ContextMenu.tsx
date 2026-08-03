// A small floating menu anchored at (x, y). Closes on any outside pointer press,
// Escape (via the modal layer stack), scroll, or window blur. We render our own
// instead of the native WebView menu (which offers only debug items like
// Reload / Inspect Element, suppressed app-wide in App.tsx). Items are usually
// CommandMenuItem (commands/CommandMenuItem.tsx), which renders straight from
// the command registry.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { placeMenu } from "@/lib/menuPlacement";
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
  // Where it actually goes, once its height is known. The first render places
  // it naively at the anchor and the layout effect corrects before paint, so
  // nothing flashes; height cannot be guessed, because a note's menu and a
  // trashed note's are different lengths and a phone's bottom row is where
  // that difference shows.
  const [at, setAt] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setAt(
      placeMenu(
        { x, y },
        { w: el.offsetWidth, h: el.offsetHeight },
        { w: window.innerWidth, h: window.innerHeight },
      ),
    );
  }, [x, y]);

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

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: at.x, top: at.y, width }}
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
        // 44 points on a client with no pointer: the smallest thing a finger
        // hits reliably. Written here rather than on any one menu because a menu
        // row is a tap target wherever it appears — the same move
        // `hoverOnlyWhenSupported` makes, fixing the rule at the control instead
        // of at the sites someone remembered. The row it was written for is the
        // host picker's (interactions.md §4a): `staging` and `prod` are adjacent
        // items in one list, and 30 points of row is how a finger runs a command
        // on the wrong machine.
        //
        // `[44px]` and not `min-h-11`, which is 2.75rem: this document's root is
        // `font: 14px` (index.css), so every rem in the app is 0.875 of its
        // nominal pixel and the utility would have quietly given 38.5. A touch
        // target is a physical size and must not ride the typographic scale.
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm touch:min-h-[44px]",
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
