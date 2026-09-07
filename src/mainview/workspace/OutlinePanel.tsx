// The Outline panel: the active note's headings, live. The right-hand panel
// slot shows one face at a time: Backlinks, Outline, or Tags, all at the same
// width (App.tsx `rightFace`).
//
// Headings come from the live editor doc rather than the file, so the outline
// tracks typing and works for an unsaved scratch note that has no file yet.
// The signal is editor/docEvents.ts. setup.ts broadcasts every doc change,
// edits and fromDisk loads alike, and the panel re-runs headingsOf. That scan
// is fence-aware, and the MCP appender uses it too (shared/wikilinks.ts).
//
// Rows are the standard keyboard list (useListNav plus a `heading` target,
// commands/target.ts). Enter, a click, or the context menu runs outline.jump,
// which moves the caret to that heading in the note's own editor. Copy Link
// yields the heading's [[Title#Heading]] wikilink.
import { useEffect, useState } from "react";
import { TableOfContents, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ContextMenu";
import { useCommands } from "@/commands/CommandProvider";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { tooltip } from "@/commands/format";
import { targetAttrs } from "@/commands/target";
import type { CommandTarget } from "@/commands/types";
import { useListNav } from "@/lib/useListNav";
import { useRowMenu } from "@/lib/useRowMenu";
import { onDocChanged } from "@/editor/docEvents";
import { headingsOf, type NoteHeading } from "../../shared/wikilinks";
import { getEditorView } from "./editorPool";
import { useWorkspace } from "./store";
import { focusedTab } from "./tree";

function targetOf(docId: string, h: NoteHeading): CommandTarget {
  return { kind: "heading", docId, line: h.line, text: h.text };
}

// Reports whether two outlines match element for element. The recompute below
// runs on every doc change, and most edits change no heading. When the two
// match, the panel keeps the previous array, so the rows do not re-render and
// the focused row keeps its identity.
function sameOutline(a: readonly NoteHeading[], b: readonly NoteHeading[]): boolean {
  return (
    a.length === b.length &&
    a.every((h, i) => h.text === b[i]!.text && h.level === b[i]!.level && h.line === b[i]!.line)
  );
}

export function OutlinePanel() {
  const { selected } = useWorkspace();
  const { exec } = useCommands();
  const nav = useListNav();
  const tab = focusedTab(selected);
  const docId = tab?.docId ?? null;
  const [headings, setHeadings] = useState<readonly NoteHeading[]>([]);
  const [menu, setMenu] = useState<{ h: NoteHeading; x: number; y: number } | null>(null);

  // Derive the headings on show and on every doc change. The pooled editor
  // exists by the time this effect runs: a pane attaches its editor from a
  // useLayoutEffect (PaneTree.tsx), and layout effects commit before any
  // passive effect. A saved note's text arrives async (editorPool.loadNote)
  // and lands as a doc change, so an empty first answer corrects on arrival.
  useEffect(() => {
    if (!docId) {
      setHeadings([]);
      return;
    }
    const recompute = () => {
      const view = getEditorView(docId);
      const next = view ? headingsOf(view.state.doc.toString()) : [];
      setHeadings((prev) => (sameOutline(prev, next) ? prev : next));
    };
    recompute();
    return onDocChanged((id) => {
      if (id === docId) recompute();
    });
  }, [docId]);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3 touch:h-[48px]">
        <TableOfContents className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Outline
        </span>
        <span className="text-[10px] text-muted-foreground/70">{headings.length || ""}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-6 touch:size-[44px]"
          onClick={() => exec("outline.toggle")}
          title={tooltip("outline.toggle")}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div {...nav.containerProps} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {!tab || !docId ? (
          <Hint>No note selected.</Hint>
        ) : headings.length === 0 ? (
          <Hint>No headings. Start a line with # to create one.</Hint>
        ) : (
          headings.map((h, i) => (
            <HeadingRow
              key={`${h.line}:${h.level}:${h.text}`}
              h={h}
              docId={docId}
              rowProps={nav.rowProps(`${h.line}:${i}`, i)}
              onJump={() => exec("outline.jump", targetOf(docId, h))}
              onContextMenu={(x, y) => setMenu({ h, x, y })}
            />
          ))
        )}
      </div>

      {menu && docId && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <CommandMenuItem
            id="outline.jump"
            target={targetOf(docId, menu.h)}
            onClose={() => setMenu(null)}
          />
          <CommandMenuItem
            id="outline.copyLink"
            target={targetOf(docId, menu.h)}
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

// One heading row: the text indented by its level, the 1-based line number on
// the right. The H1, usually the note's title, renders in a heavier weight.
function HeadingRow({
  h,
  docId,
  rowProps,
  onJump,
  onContextMenu,
}: {
  h: NoteHeading;
  docId: string;
  rowProps: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  onJump: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const press = useRowMenu(onContextMenu, onJump);
  return (
    <div
      {...rowProps}
      {...targetAttrs(targetOf(docId, h))}
      {...press}
      className="flex cursor-default items-center gap-2 rounded-md py-1 pr-2 outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
      style={{ paddingLeft: 8 + (h.level - 1) * 14 }}
    >
      <span
        className={`min-w-0 flex-1 truncate text-[13px] leading-tight ${h.level === 1 ? "font-medium" : ""}`}
      >
        {h.text}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{h.line}</span>
    </div>
  );
}
