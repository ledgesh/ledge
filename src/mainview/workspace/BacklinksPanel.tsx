// The Backlinks panel: which notes [[link]] to the note in the focused pane's
// active tab. The right-hand mirror of the sidebar — Shell owns its open state
// and width like the terminal drawer's (ephemeral chrome, architecture.md §5).
//
// The list is Bun's answer over the noteBacklinks RPC (the same scan the MCP
// `backlinks` tool runs); the view never holds the linking notes' bodies. Rows
// are the standard keyboard-navigable kind (useListNav + a `backlink` target,
// commands/target.ts): Enter — or a click, or the context menu — runs
// backlink.open, which opens the linking note with its [[link]] line revealed
// and selected, the search overlay's open-at-the-hit.
import { useEffect, useRef, useState } from "react";
import { FileText, Link2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ContextMenu";
import { useCommands } from "@/commands/CommandProvider";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { tooltip } from "@/commands/format";
import { targetAttrs } from "@/commands/target";
import type { CommandTarget } from "@/commands/types";
import { useListNav } from "@/lib/useListNav";
import { useRowMenu } from "@/lib/useRowMenu";
import { backlinksOf, onNotesChanged, type BacklinkHit } from "@/notes/channel";
import { notesOf, useWorkspace } from "./store";
import { focusedTab } from "./tree";

function targetOf(hit: BacklinkHit): CommandTarget {
  return { kind: "backlink", path: hit.path, line: hit.line, raw: hit.raw };
}

export function BacklinksPanel() {
  const { state, selected } = useWorkspace();
  const { exec } = useCommands();
  const nav = useListNav();
  const tab = focusedTab(selected);
  const path = tab?.path ?? null;
  // null is "no answer yet" — the panel goes quiet rather than flashing the
  // empty state while the first fetch is in flight.
  const [hits, setHits] = useState<BacklinkHit[] | null>(null);
  // Locked notes' bodies are never scanned (locking.md §4); the footer
  // says so where the missing rows would have been.
  const [lockedSkipped, setLockedSkipped] = useState(0);
  const [menu, setMenu] = useState<{ hit: BacklinkHit; x: number; y: number } | null>(null);

  // Refetch when the shown note changes and when its folder's files do. The
  // folder's note list covers both change routes with one dependency: the
  // watcher push and the focus refresh each land in refreshFolder, whose
  // dispatch replaces notesOf's array — including for Ledge's own saves,
  // which the watcher reports unfiltered (rpc notesChanged). The direct
  // onNotesChanged subscription below is the low-latency half: it fires
  // before the folder re-list round-trips, so an agent edit shows up here as
  // fast as it does in the editor.
  const folderNotes = notesOf(state, selected.folder);
  const generation = useRef(0);
  useEffect(() => {
    const fetchNow = () => {
      const gen = (generation.current += 1);
      if (!path) {
        setHits([]);
        setLockedSkipped(0);
        return;
      }
      void backlinksOf(path).then(
        (b) => {
          if (generation.current !== gen) return;
          setHits(b.backlinks);
          setLockedSkipped(b.lockedSkipped);
        },
        (err) => {
          // A failed scan (unmounted volume mid-session, say) costs the list,
          // not the app; the panel shows the empty state rather than lying
          // with stale rows.
          console.error("[backlinks] scan failed for", path, err);
          if (generation.current !== gen) return;
          setHits([]);
          setLockedSkipped(0);
        },
      );
    };
    fetchNow();
    return onNotesChanged((root) => {
      if (root === selected.folder) fetchNow();
    });
  }, [path, selected.folder, folderNotes]);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l bg-background">
      {/* 48 and 44 on touch, the same pair the app header takes and for the
          same reason (§1a). The Outline and Tags panels are the other two faces
          of this slot and carry it identically — on a phone the panel covers
          the note, so its ✕ is the only way back. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3 touch:h-[48px]">
        <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Backlinks
        </span>
        <span className="text-[10px] text-muted-foreground/70">{hits?.length || ""}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-6 touch:size-[44px]"
          onClick={() => exec("backlinks.toggle")}
          title={tooltip("backlinks.toggle")}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div {...nav.containerProps} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {!tab ? (
          <Hint>No note selected.</Hint>
        ) : !path ? (
          <Hint>This note has no file yet — it is saved on its first edit, and links resolve to it from then on.</Hint>
        ) : hits && hits.length === 0 ? (
          <Hint>
            No notes link here. A note links to “{tab.title}” by mentioning [[{tab.title}]].
          </Hint>
        ) : (
          (hits ?? []).map((hit, i) => (
            <BacklinkRow
              key={`${hit.path}:${hit.line}:${i}`}
              hit={hit}
              rowProps={nav.rowProps(`${hit.path}:${hit.line}`, i)}
              onOpen={() => exec("backlink.open", targetOf(hit))}
              onContextMenu={(x, y) => setMenu({ hit, x, y })}
            />
          ))
        )}
      </div>

      {lockedSkipped > 0 && path && (
        <p
          data-testid="backlinks-locked-skipped"
          className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          {lockedSkipped} locked {lockedSkipped === 1 ? "note" : "notes"} not scanned
        </p>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem
            id="backlink.open"
            target={targetOf(menu.hit)}
            onClose={() => setMenu(null)}
          />
          {/* The linking note is an ordinary note; Copy Path is the note-row
              command with a note target, not a second implementation. */}
          <CommandMenuItem
            id="note.copyPath"
            target={{ kind: "note", path: menu.hit.path }}
            onClose={() => setMenu(null)}
          />
        </ContextMenu>
      )}
    </aside>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">{children}</p>;
}

// One incoming link: the linking note's title, with the line the link sits on
// beneath it. One row per OCCURRENCE, not per note — the same note linking
// three times is three places to jump to.
function BacklinkRow({
  hit,
  rowProps,
  onOpen,
  onContextMenu,
}: {
  hit: BacklinkHit;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const press = useRowMenu(onContextMenu, onOpen);
  return (
    <div
      {...rowProps}
      {...targetAttrs(targetOf(hit))}
      {...press}
      className="group flex cursor-default flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
      title={hit.path}
    >
      <div className="flex min-w-0 items-center gap-2">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">{hit.title}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{hit.line}</span>
      </div>
      <div className="truncate pl-[22px] text-[11px] leading-snug text-muted-foreground">
        {hit.context}
      </div>
    </div>
  );
}
