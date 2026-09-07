// The anchored "which machine?" menu for a note that declares more than one
// host. Every inline run opens it, so a note listing prod next to staging
// never runs a block on a remembered default. The terminal drawer asks only
// when its shell is not yet alive (interactions.md §4a). The session's last
// pick opens focused: Enter confirms, arrow keys move, and Escape (the shared
// layer stack in commands/layers.ts) or an outside press cancels.
//
// A touch client has no Enter and no arrow keys, so every row there costs one
// tap. Without a mark, the focus ring would be the only thing saying which
// machine ran last. The preferred row therefore shows a check as well, on
// every client, because a focus ring is no easier to read on a Mac.
import { useEffect, useRef } from "react";
import { Check, Server, Laptop } from "lucide-react";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { middleEllipsis } from "../commands/format";
import { LOCAL_HOST } from "../../shared/frontmatter";
import type { HostPickRequest } from "../editor/bridge";

// MENU_WIDTH is the menu's width in pixels. LABEL_MAX is the longest host
// name that fits it at the 12px monospace of the rows below, three characters
// short of what the width alone allows. That leaves the marked row room for
// its check, and it caps every label at the same count so the rows line up.
// Longer names middle-ellipsize (commands/format.ts) and show in full in the
// row's tooltip. The ellipsis goes in the middle because the tail is what
// tells `…-01` from `…-02`.
const MENU_WIDTH = 280;
const LABEL_MAX = 27;

export function HostPicker({ req, onClose }: { req: HostPickRequest; onClose: () => void }) {
  const listRef = useRef<HTMLDivElement>(null);

  // Focus the preferred host (or the first) once mounted. Enter then repeats
  // the last choice, and choosing a different machine takes an arrow key
  // first.
  useEffect(() => {
    const items = listRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]");
    if (!items?.length) return;
    const i = Math.max(0, req.hosts.indexOf(req.preferred ?? ""));
    items[Math.min(i, items.length - 1)]?.focus();
  }, [req]);

  // Roving focus on arrows; Enter activates the focused button natively.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <ContextMenu x={req.anchor.x} y={req.anchor.y} width={MENU_WIDTH} onClose={onClose}>
      <div ref={listRef} onKeyDown={onKeyDown}>
        <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Run on</div>
        {req.hosts.map((host) => (
          <MenuItem
            key={host}
            title={host}
            onSelect={() => {
              onClose();
              req.onPick(host);
            }}
          >
            {host === LOCAL_HOST ? (
              <Laptop className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Server className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
              {middleEllipsis(host, LABEL_MAX)}
            </span>
            {host === req.preferred && (
              <Check data-preferred="true" aria-label="ran here last" className="size-3.5 shrink-0" />
            )}
          </MenuItem>
        ))}
      </div>
    </ContextMenu>
  );
}
