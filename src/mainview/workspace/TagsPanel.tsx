// The Tags panel: the right panel's third face. Two levels in one slot —
// the selected workspace's tag directory (every tag its notes carry, with
// per-note counts), and the drill-in listing one tag's occurrences across
// the workspace. Which tag is drilled lives in Shell (tagShown), not here:
// clicks elsewhere route INTO that selection through ui.showTag — a rendered
// #tag in the editor, a tag row in the overlay, and a directory row below
// all converge on the one tag.open verb.
//
// The lists are Bun's answers over the tagList/tagNotes RPCs (the same scan
// the MCP `tags` tool runs); the view never holds note bodies. Rows are the
// standard keyboard-navigable kind (useListNav + targets, commands/
// target.ts): a directory row's Enter drills in; an occurrence row's Enter
// runs tag.openNote, backlink.open's open-at-the-place with a tag target.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, FileText, Hash, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ContextMenu";
import { useCommands } from "@/commands/CommandProvider";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { tooltip } from "@/commands/format";
import { targetAttrs } from "@/commands/target";
import type { CommandTarget } from "@/commands/types";
import { useListNav } from "@/lib/useListNav";
import { listTags, notesTagged, onNotesChanged, type TagHit } from "@/notes/channel";
import type { TagInfo } from "../../shared/tags";
import { notesOf, useWorkspace } from "./store";

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
  // null is "no answer yet" — quiet, not a flashed empty state, the
  // BacklinksPanel stance.
  const [tags, setTags] = useState<TagInfo[] | null>(null);
  const [hits, setHits] = useState<TagHit[] | null>(null);
  const [menu, setMenu] = useState<{ hit: TagHit; x: number; y: number } | null>(null);

  // Refetch when the drill level changes and when the folder's files do —
  // the BacklinksPanel arrangement: folderNotes covers the store-refresh
  // route, the direct onNotesChanged subscription is the low-latency half,
  // and the generation counter drops answers that arrive out of turn.
  const folderNotes = notesOf(state, selected.folder);
  const generation = useRef(0);
  useEffect(() => {
    const fetchNow = () => {
      const gen = (generation.current += 1);
      if (tag === null) {
        void listTags(selected.folder).then(
          (t) => {
            if (generation.current === gen) setTags(t);
          },
          (err) => {
            // A failed scan costs the list, not the app (unmounted volume
            // mid-session, say); empty beats lying with stale rows.
            console.error("[tags] scan failed for", selected.folder, err);
            if (generation.current === gen) setTags([]);
          },
        );
      } else {
        void notesTagged(selected.folder, tag).then(
          (h) => {
            if (generation.current === gen) setHits(h);
          },
          (err) => {
            console.error("[tags] scan failed for", tag, err);
            if (generation.current === gen) setHits([]);
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
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3">
        {drilled ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 -ml-1.5"
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
          className="size-6"
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
          // Reachable: the drilled tag's last bearer was just edited away.
          <Hint>No notes carry #{tag} anymore.</Hint>
        ) : (
          (hits ?? []).map((hit, i) => (
            <HitRow
              key={`${hit.path}:${hit.line}:${i}`}
              hit={hit}
              rowProps={nav.rowProps(`${hit.path}:${hit.line}`, i)}
              onOpen={() => exec("tag.openNote", hitTarget(hit))}
              onContextMenu={(x, y) => setMenu({ hit, x, y })}
            />
          ))
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem id="tag.openNote" target={hitTarget(menu.hit)} onClose={() => setMenu(null)} />
          {/* The bearing note is an ordinary note; Copy Path is the note-row
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
      className="group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onOpen}
    >
      <Hash className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">{info.tag}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{info.count}</span>
    </div>
  );
}

// One occurrence of the drilled tag: the bearing note's title, with the line
// the tag sits on beneath it. Per OCCURRENCE, not per note — BacklinkRow's
// reasoning: the same note tagged three times is three places to jump to.
function HitRow({
  hit,
  rowProps,
  onOpen,
  onContextMenu,
}: {
  hit: TagHit;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      {...rowProps}
      {...targetAttrs(hitTarget(hit))}
      className="group flex cursor-default flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
      title={hit.path}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
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
