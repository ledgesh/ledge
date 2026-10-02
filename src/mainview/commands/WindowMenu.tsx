// The menus in the window's header, on a desktop with no native menu bar
// (lib/shell.ts menuInWindow, interactions.md §10). One title per section of
// the Mac's bar, from the same spec (menu.ts windowMenu), each opening a
// ContextMenu of registry commands. A submenu (Switch to Workspace) is drawn
// inline as a labelled group, since ContextMenu has no flyouts.
import { Fragment, useCallback, useRef, useState } from "react";
import { ContextMenu, MenuDivider } from "@/components/ContextMenu";
import { CommandMenuItem } from "./CommandMenuItem";
import { useCommands } from "./CommandProvider";
import { windowMenu } from "./menu";
import type { AppMenuItem } from "../../shared/rpc-schema";
import { cn } from "@/lib/utils";

// A press on the open menu's own title closes it through ContextMenu's
// outside-press handler before the click lands. A click that soon after that
// close, on that title, is the same gesture and must not reopen it.
const SAME_PRESS_MS = 300;

export function WindowMenu() {
  const { commands, ctx } = useCommands();
  const [open, setOpen] = useState<{ label: string; x: number; y: number } | null>(null);
  const openLabel = useRef<string | null>(null);
  const lastClose = useRef({ label: "", at: 0 });

  const close = useCallback(() => {
    lastClose.current = { label: openLabel.current ?? "", at: performance.now() };
    openLabel.current = null;
    setOpen(null);
  }, []);

  const show = (label: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    openLabel.current = label;
    setOpen({ label, x: r.left, y: r.bottom + 2 });
  };

  // Built when drawn, so enablement and the hidden faces are read live rather
  // than from a snapshot the way the native bar has to (menu.ts).
  const sections = windowMenu(commands, ctx());
  const current = open ? sections.find((s) => !("type" in s) && s.label === open.label) : undefined;

  return (
    <nav className="flex items-center" aria-label="Menus">
      {sections.map((s) =>
        "type" in s ? null : (
          <button
            key={s.label}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open?.label === s.label}
            className={cn(
              "rounded px-2 py-1 text-[13px] hover:bg-accent hover:text-accent-foreground",
              open?.label === s.label && "bg-accent text-accent-foreground",
            )}
            onClick={(e) => {
              const again = lastClose.current.label === s.label && performance.now() - lastClose.current.at < SAME_PRESS_MS;
              if (!again) show(s.label, e.currentTarget);
            }}
            // A menu bar's rule: with one menu open, pointing at another title
            // opens that one instead.
            onPointerEnter={(e) => {
              if (openLabel.current !== null && openLabel.current !== s.label) show(s.label, e.currentTarget);
            }}
          >
            {s.label}
          </button>
        ),
      )}
      {open && current && !("type" in current) && (
        <ContextMenu key={open.label} x={open.x} y={open.y} width={300} onClose={close}>
          <Items items={current.submenu ?? []} onClose={close} />
        </ContextMenu>
      )}
    </nav>
  );
}

function Items({ items, onClose }: { items: readonly AppMenuItem[]; onClose: () => void }) {
  return (
    <>
      {items.map((item, i) => {
        if ("type" in item) return <MenuDivider key={`divider-${i}`} />;
        if (item.submenu) {
          return (
            <Fragment key={item.label}>
              <div className="px-2 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">{item.label}</div>
              <Items items={item.submenu} onClose={onClose} />
            </Fragment>
          );
        }
        return item.action ? <CommandMenuItem key={item.action} id={item.action} label={item.label} onClose={onClose} /> : null;
      })}
    </>
  );
}
