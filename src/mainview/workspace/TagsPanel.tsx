// The Tags panel is the third of three faces that share the right panel's
// one slot. Its directory lists every tag the selected workspace's notes
// carry and how many notes bear each. Drilling into a tag lists that tag's
// occurrences across the workspace.
//
// Shell (App.tsx) holds the drilled tag in tagShown, not this file. Tag
// clicks converge on its ui.showTag hook: the tag.open command runs the hook
// for a directory row below and for an overlay tag row, and the editor's
// rendered #tag reaches it through the bridge (editor/bridge.ts).
//
// Both levels are answered over the tagList and tagNotes RPCs, the scan
// behind the MCP `tags` tool. No note bodies reach the view. Rows are
// keyboard navigable (useListNav, with `tag` and `tagnote` targets from
// commands/target.ts). Enter drills into a directory row. Enter on an
// occurrence row runs tag.openNote, backlink.open's body with a tag target.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, FileText, Hash, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ContextMenu";
import { useCommands } from "@/commands/CommandProvider";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { tooltip } from "@/commands/format";
import { targetAttrs } from "@/commands/target";
import type { CommandTarget } from "@/commands/types";
import { useListNav } from "@/lib/useListNav";
import { useRowMenu } from "@/lib/useRowMenu";
import { listTags, notesTagged, onNotesChanged, type TagHit } from "@/notes/channel";
import type { TagInfo } from "../../shared/tags";
import { notesOf, useWorkspace } from "./store";
import { FolderLabel, folderIndex } from "@/notes/FolderLabel";

function tagTarget(info: TagInfo): CommandTarget {
  return { kind: "tag", tag: info.tag };
}

function hitTarget(hit: TagHit): CommandTarget {
  return { kind: "tagnote", path: hit.path, line: hit.line, raw: hit.raw };
}

export function TagsPanel({ tag, onBack }: { tag: string | null; onBack: () => void }) {
  const { state, selected } = useWorkspace();
  const { exec } = useCommands();
  const nav = useListNav();
  // null means no answer yet. The panel stays quiet during the first fetch
  // rather than flashing the empty state.
  const [tags, setTags] = useState<TagInfo[] | null>(null);
  const [hits, setHits] = useState<TagHit[] | null>(null);
  // How many of the scanned notes are locked, for the footer below. A locked
  // note's body is never scanned (locking.md §4). Its frontmatter tags still
  // count: those sit in the plaintext head (locking.md §6).
  const [lockedSkipped, setLockedSkipped] = useState(0);
  const [menu, setMenu] = useState<{ hit: TagHit; x: number; y: number } | null>(null);

  // Refetch when the drill level changes and when the folder's files do, the
  // same arrangement as BacklinksPanel. The folderNotes dependency covers the
  // store refresh. The onNotesChanged subscription below refetches without
  // waiting for that re-list. The generation counter drops answers that
  // arrive out of turn.
  const folderNotes = notesOf(state, selected.folder);
  // Where each bearing note lives: a hit carries a path and a title, not a
  // placement (notes/FolderLabel.tsx).
  const folders = useMemo(() => folderIndex(folderNotes), [folderNotes]);
  const generation = useRef(0);
  useEffect(() => {
    const fetchNow = () => {
      const gen = (generation.current += 1);
      if (tag === null) {
        void listTags(selected.folder).then(
          (t) => {
            if (generation.current !== gen) return;
            setTags(t.tags);
            setLockedSkipped(t.lockedSkipped);
          },
          (err) => {
            // A failed scan (an unmounted volume mid-session, say) empties
            // the list instead of leaving stale rows on screen. The rejection
            // is logged and stops here, so it costs the list, not the app.
            console.error("[tags] scan failed for", selected.folder, err);
            if (generation.current !== gen) return;
            setTags([]);
            setLockedSkipped(0);
          },
        );
      } else {
        void notesTagged(selected.folder, tag).then(
          (h) => {
            if (generation.current !== gen) return;
            setHits(h.hits);
            setLockedSkipped(h.lockedSkipped);
          },
          (err) => {
            console.error("[tags] scan failed for", tag, err);
            if (generation.current !== gen) return;
            setHits([]);
            setLockedSkipped(0);
          },
        );
      }
    };
    fetchNow();
    return onNotesChanged((root) => {
      if (root === selected.folder) fetchNow();
    });
  }, [tag, selected.folder, folderNotes]);

  const drilled = tag !== null;
  const count = drilled ? hits?.length : tags?.length;

  return (
    <aside className="flex h-full min-h-0 flex-col border-l bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3 touch:h-[48px]">
        {drilled ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 -ml-1.5 touch:size-[44px]"
            onClick={onBack}
            title="All tags"
          >
            <ChevronLeft className="size-3.5" />
          </Button>
        ) : (
          <Hash className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {drilled ? `#${tag}` : "Tags"}
        </span>
        <span className="text-[10px] text-muted-foreground/70">{count || ""}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-6 touch:size-[44px]"
          onClick={() => exec("tags.toggle")}
          title={tooltip("tags.toggle")}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div {...nav.containerProps} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {!drilled ? (
          tags && tags.length === 0 ? (
            <Hint>
              No tags yet. A note carries a tag by mentioning #it in its text, or listing it on a
              frontmatter “tags:” line.
            </Hint>
          ) : (
            (tags ?? []).map((info, i) => (
              <TagRow
                key={info.tag}
                info={info}
                rowProps={nav.rowProps(info.tag, i)}
                onOpen={() => exec("tag.open", tagTarget(info))}
              />
            ))
          )
        ) : hits && hits.length === 0 ? (
          // Reachable when the drilled tag's last bearer was just edited away.
          <Hint>No notes carry #{tag} anymore.</Hint>
        ) : (
          (hits ?? []).map((hit, i) => (
            <HitRow
              key={`${hit.path}:${hit.line}:${i}`}
              hit={hit}
              folder={folders.get(hit.path)}
              rowProps={nav.rowProps(`${hit.path}:${hit.line}`, i)}
              onOpen={() => exec("tag.openNote", hitTarget(hit))}
              onContextMenu={(x, y) => setMenu({ hit, x, y })}
            />
          ))
        )}
      </div>

      {lockedSkipped > 0 && (
        <p
          data-testid="tags-locked-skipped"
          className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          {lockedSkipped} locked note {lockedSkipped === 1 ? "body" : "bodies"} not scanned
        </p>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem id="tag.openNote" target={hitTarget(menu.hit)} onClose={() => setMenu(null)} />
          {/* The bearing note is an ordinary note. Copy Path is the note-row
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

// One tag of the directory: its display spelling (the workspace's most
// frequent one, shared/tags.ts) and how many notes bear it.
function TagRow({
  info,
  rowProps,
  onOpen,
}: {
  info: TagInfo;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onOpen: () => void;
}) {
  return (
    <div
      {...rowProps}
      {...targetAttrs(tagTarget(info))}
      className="group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
      onClick={onOpen}
    >
      <Hash className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">{info.tag}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{info.count}</span>
    </div>
  );
}

// One occurrence of the drilled tag: the bearing note's title, with the line
// the tag sits on beneath it. One row per occurrence, not per note, so a note
// tagged three times gets three rows. BacklinkRow (BacklinksPanel.tsx) is the
// same row under the same rule.
function HitRow({
  hit,
  folder,
  rowProps,
  onOpen,
  onContextMenu,
}: {
  hit: TagHit;
  // Where the bearing note lives, or undefined at the top level.
  folder: string | undefined;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const press = useRowMenu(onContextMenu, onOpen);
  return (
    <div
      {...rowProps}
      {...targetAttrs(hitTarget(hit))}
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
