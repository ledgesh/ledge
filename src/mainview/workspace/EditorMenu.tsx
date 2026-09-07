// The note editor's context menu (interactions.md §11). It makes no decisions.
// editor/rightClick.ts places the caret and reports what the pointer landed on.
// commands/editorMenu.ts decides which commands the click calls for. This
// renders the result through the same CommandMenuItem every other menu uses, so
// titles, icons, key chips and enablement come from the registry.
import { ContextMenu, MenuDivider } from "@/components/ContextMenu";
import { CommandMenuItem } from "@/commands/CommandMenuItem";
import { editorMenu, type EditorClickContext } from "@/commands/editorMenu";
import { prepareEditorMenu, targetUnder } from "@/editor/rightClick";
import { getEditorView } from "./editorPool";

/** An open menu: what the click landed on, and where to draw it. */
export interface EditorMenuAnchor extends EditorClickContext {
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
  if (!host || !view) return null;
  const el = targetUnder(e.target as Element | null, e.clientX, e.clientY);
  if (!el || !host.contains(el)) return null;
  const ctx = prepareEditorMenu(view, el, e.clientX, e.clientY, readOnly);
  return ctx && { ...ctx, x: e.clientX, y: e.clientY };
}

export function EditorMenu({ at, onClose }: { at: EditorMenuAnchor; onClose: () => void }) {
  return (
    // Wider than the 200 every row menu takes: "Paste as Plain Text" and "Run
    // Block in Terminal" carry a chip each and would wrap at the default.
    <ContextMenu x={at.x} y={at.y} width={224} onClose={onClose}>
      {editorMenu(at).map((item, i) =>
        item === "---" ? (
          <MenuDivider key={`sep${i}`} />
        ) : (
          <CommandMenuItem key={item} id={item} onClose={onClose} />
        ),
      )}
    </ContextMenu>
  );
}
