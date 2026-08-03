// The anchored "which machine?" menu for notes that declare more than one
// host. It interposes on every run (interactions.md §4 spirit: prod next to
// staging must never execute on a remembered default), so it must cost almost
// nothing when the answer is "same as last time": it opens with the session's
// last pick focused, Enter confirms, arrows move, Escape (via the ContextMenu
// layer) or an outside press cancels — the whole exchange stays on the keys
// that asked for the run.
//
// On a touch client none of that grammar exists, and the preselection is the
// part that suffers: there is no Enter to make it cheap and no arrow to make
// leaving it deliberate, so every row costs one tap and the focus ring is
// carrying a fact nothing else says. So the preferred row is MARKED as well as
// focused — the same information, in the one form a client with no keyboard can
// read. Marked on every client, because a Mac reading it is a Mac not squinting
// at a focus ring either.
import { useEffect, useRef } from "react";
import { Check, Server, Laptop } from "lucide-react";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { middleEllipsis } from "../commands/format";
import { LOCAL_HOST } from "../../shared/frontmatter";
import type { HostPickRequest } from "../editor/bridge";

// ~what fits the widened menu at the 12px mono below. Longer destinations
// middle-ellipsize — the tail is what tells `…-01` from `…-02`, so an
// end-ellipsis would render the exact items this menu exists to distinguish
// as identical — and carry the full value in their tooltip. Three characters
// shorter than the width alone allows, so the marked row below has somewhere to
// put its mark and every row stays the same length as the ones it is being
// compared against.
const MENU_WIDTH = 280;
const LABEL_MAX = 27;

export function HostPicker({ req, onClose }: { req: HostPickRequest; onClose: () => void }) {
  const listRef = useRef<HTMLDivElement>(null);

  // Focus the preferred host (or the first) once mounted, so Enter repeats the
  // last choice and a different machine takes a deliberate arrow first.
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
