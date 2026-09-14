// The note editor's context menu (interactions.md §11). It makes no decisions.
// editor/rightClick.ts places the caret and reports what the pointer landed on.
// commands/editorMenu.ts decides which commands the click calls for. This
// renders the result through the same CommandMenuItem every other menu uses, so
// titles, icons, key chips and enablement come from the registry.
import { useEffect, useState } from "react";
import { ContextMenu, MenuDivider } from "@/components/ContextMenu";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { editorMenu } from "@/commands/editorMenu";
import type { CommandTarget } from "@/commands/types";
import { prepareEditorMenu, targetUnder, type PreparedClick } from "@/editor/rightClick";
import { lookUpWord, type Misspelling } from "@/editor/spelling";
import { getEditorView } from "./editorPool";

/** An open menu: what the click landed on, in which note, and where to draw
 * it. */
export interface EditorMenuAnchor extends PreparedClick {
  docId: string;
  x: number;
  y: number;
}

/**
 * Builds the anchor for a right-click in the pane whose editor host is `host`.
 * Null means no menu: another pane's editor, a dialog over this one, an empty
 * pane, a locked note's placeholder, a run panel.
 *
 * `e` is a native event from a window listener, not React's synthetic one, and
 * that is forced: link hotspots sit in the body, outside the React tree
 * (editor/livePreview.ts), so an onContextMenu on the host would never see
 * those clicks. Every pane hears every right-click, so each pane checks
 * `host.contains` and ignores clicks outside its own host.
 * `prepareEditorMenu` moves the caret as the menu opens, unless the click
 * lands inside the selection. Both rules come from interactions.md §11.
 */
export function editorMenuAt(
  e: MouseEvent,
  host: HTMLElement | null,
  docId: string | null,
  readOnly: boolean,
): EditorMenuAnchor | null {
  const view = docId ? getEditorView(docId) : null;
  if (!host || !docId || !view) return null;
  const el = targetUnder(e.target as Element | null, e.clientX, e.clientY);
  if (!el || !host.contains(el)) return null;
  const ctx = prepareEditorMenu(view, el, e.clientX, e.clientY, readOnly);
  return ctx && { ...ctx, docId, x: e.clientX, y: e.clientY };
}

export function EditorMenu({ at, onClose }: { at: EditorMenuAnchor; onClose: () => void }) {
  // The word under the pointer goes to this device's dictionary before the
  // menu draws, so the spelling group does not arrive under a pointer already
  // moving to Copy. lookUpWord gives up after a few hundred milliseconds and
  // the menu then opens without it. Undefined is still asking.
  const [misspelling, setMisspelling] = useState<Misspelling | null | undefined>(at.word ? undefined : null);
  useEffect(() => {
    if (!at.word) return;
    let live = true;
    void lookUpWord(at.word).then((m) => {
      if (live) setMisspelling(m);
    });
    return () => {
      live = false;
    };
  }, [at.word]);
  if (misspelling === undefined) return null;

  // A guess's item and Learn Spelling ("" for no guess) share one target shape.
  const target = (guess: string): CommandTarget | undefined =>
    misspelling
      ? { kind: "misspelling", docId: at.docId, from: misspelling.from, to: misspelling.to, word: misspelling.word, guess }
      : undefined;
  return (
    // Wider than the 200 every row menu takes: "Paste as Plain Text" and "Run
    // Block in Terminal" carry a chip each and would wrap at the default.
    <ContextMenu x={at.x} y={at.y} width={224} onClose={onClose}>
      {editorMenu({ ...at, guesses: misspelling?.guesses ?? null }).map((item, i) =>
        item === "---" ? (
          <MenuDivider key={`sep${i}`} />
        ) : typeof item === "object" ? (
          <CommandMenuItem key={`guess${i}`} id="spelling.replace" target={target(item.guess)} onClose={onClose} />
        ) : (
          <CommandMenuItem key={item} id={item} target={item === "spelling.learn" ? target("") : undefined} onClose={onClose} />
        ),
      )}
    </ContextMenu>
  );
}
