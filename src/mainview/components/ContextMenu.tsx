// A small floating menu anchored at (x, y). It closes on an outside pointer
// press, Escape (via the modal layer stack), scroll, or window blur. It
// replaces the native WebView menu of debug items (Reload, Inspect Element),
// which App.tsx suppresses app-wide. Items are usually CommandMenuItem
// (commands/CommandMenuItem.tsx), which renders from the command registry.
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
  // Menu width in pixels. Two menus pass more because their labels are
  // longer: the editor's context menu passes 224 (workspace/EditorMenu.tsx),
  // and the host picker's menu of ssh destinations passes 280
  // (components/HostPicker.tsx).
  width?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Where the menu ends up once its height has been measured. The layout
  // effect below corrects the first render's anchor position before paint, so
  // nothing flashes. The height is not known until then: a note's menu and a
  // trashed note's hold different numbers of items. The height decides
  // placement at a screen edge, such as a long press on a phone's last row.
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
    // Escape goes through the shared layer stack (commands/layers.ts), so a
    // menu above a dialog above the palette closes top first. While any layer
    // is open, the window command dispatcher is suppressed.
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

/** A horizontal rule between groups of items. The editor's menu groups its
 * verbs by the click target, the clipboard, and the writing commands.
 * commands/editorMenu.ts places those breaks and drops an empty group's
 * divider, so that menu never leads, ends, or doubles one. A divider written
 * by hand carries no such guarantee: notes/NoteBrowser.tsx places one above
 * its Delete Folder… row. The negative margins let the rule reach both edges,
 * past the menu's `p-1`. */
export function MenuDivider() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-border" />;
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
  // Right-aligned key chip ("⌘W"). Take it from the command registry
  // (commands/CommandMenuItem.tsx), never hand-write one: a hand-written chip
  // drifts from the keymap.
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
        // At least 44 points on a touch client, the floor for adjacent
        // choices (interactions.md §1a; the host picker is why, §4a). The
        // rule sits on this shared control rather than on remembered call
        // sites, as `hoverOnlyWhenSupported` does in tailwind.config.js.
        // `[44px]`, not `min-h-11`: the root font is 14px (index.css), so
        // 2.75rem is 38.5px here. A touch target must not be written in rem.
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
