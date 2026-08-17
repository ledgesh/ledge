// The note editor's context menu (interactions.md §11) — the surface every
// other object in the app has had and the one the user spends all day in did
// not.
//
// It makes no decisions: editor/rightClick.ts places the caret and says what
// the pointer landed on, commands/editorMenu.ts says which verbs that calls
// for, and this renders them through the same CommandMenuItem every other menu
// uses, so titles, icons, key chips and enablement all still come from the
// registry.
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
 * Answer a right-click for the pane whose editor host is `host`, or null when
 * there is no menu to open: another pane's editor, a dialog over this one, an
 * empty pane, a locked note's placeholder, a run panel.
 *
 * The event is a native one from a window listener rather than React's, and
 * that is forced: the hotspots over rendered links sit in the body, outside
 * the React tree entirely (editor/rightClick.ts targetUnder), so an
 * onContextMenu on the host would never hear the clicks this menu most wants.
 * Hence `host.contains` — with the listener on the window, the pane has to
 * decide for itself whether the gesture was its own.
 *
 * The caret moves as a side effect. That is the platform's rule and it has to
 * happen before the menu reads the selection, not when an item is picked.
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
