// The Backlinks panel lists the notes that [[link]] to the note in the focused
// pane's active tab. It is the sidebar's right-hand mirror. Shell (App.tsx)
// owns the slot's open state and width the way it owns the terminal drawer's
// (ephemeral chrome, architecture.md §5).
//
// Bun owns the scan and answers over the noteBacklinks RPC, the same scan the
// MCP `backlinks` tool runs. The view never holds the linking notes' bodies.
// Rows are the standard keyboard-navigable kind (useListNav plus a `backlink`
// target, commands/target.ts). Enter, a click, or the context menu runs
// backlink.open, which opens the linking note with its [[link]] line revealed
// and selected, the same open-at-the-hit move the search overlay makes
// (commands/Overlay.tsx).
import { useEffect, useMemo, useRef, useState } from "react";
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
import { FolderLabel, folderIndex } from "@/notes/FolderLabel";
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
  // null means no answer yet. The panel renders nothing during the first
  // fetch rather than flashing the empty state.
  const [hits, setHits] = useState<BacklinkHit[] | null>(null);
  // Locked notes' bodies are never scanned (locking.md §4). A footer below
  // gives the count.
  const [lockedSkipped, setLockedSkipped] = useState(0);
  const [menu, setMenu] = useState<{ hit: BacklinkHit; x: number; y: number } | null>(null);

  // Refetch when the shown note changes (the `path` dependency below) and when
  // its folder's files do. Two routes change the folder's files: the watcher
  // push (rpc notesChanged, which reports Ledge's own saves too) and the
  // refresh on window focus. Each lands in refreshFolder, whose dispatch
  // replaces notesOf's array, so the folderNotes dependency covers them. The
  // onNotesChanged subscription below is the low-latency path: it fires before
  // the folder re-list round-trips, so an agent edit shows up here as fast as
  // it does in the editor.
  const folderNotes = notesOf(state, selected.folder);
  // Where each linking note lives: a hit carries a path and a title, not a
  // placement (notes/FolderLabel.tsx).
  const folders = useMemo(() => folderIndex(folderNotes), [folderNotes]);
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
          // A failed scan (an unmounted volume mid-session, say) costs this
          // list and not the app: the rows are emptied instead of left stale
          // on screen, and the panel shows its empty state.
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
          same reason (interactions.md §1a). The Outline and Tags panels are
          the other two faces of this slot and carry it identically. On a phone
          the panel covers the note, so its ✕ is the only way back. */}
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
              folder={folders.get(hit.path)}
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
          {/* The linking note is an ordinary note. Copy Path is the note-row
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
// beneath it. One row per occurrence, not per note, so a note that links three
// times produces three rows.
function BacklinkRow({
  hit,
  folder,
  rowProps,
  onOpen,
  onContextMenu,
}: {
  hit: BacklinkHit;
  // Where the linking note lives, or undefined at the top level.
  folder: string | undefined;
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
        {/* Which of two same-titled notes this is (notes/FolderLabel.tsx). */}
        <FolderLabel folder={folder} />
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{hit.line}</span>
      </div>
      <div className="truncate pl-[22px] text-[11px] leading-snug text-muted-foreground">
        {hit.context}
      </div>
    </div>
  );
}
