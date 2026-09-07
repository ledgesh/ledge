// What a right-click in a note does before its menu opens (interactions.md
// §11): it places the caret, then reports what it landed on so the spec in
// commands/editorMenu.ts can decide which verbs to carry.
//
// Pointer-only, with no touch form: interactions.md §1a says why, and why the
// row menus (lib/useRowMenu.ts) open on a long press when this does not.
import type { EditorView } from "@codemirror/view";
import { runnableBlockAt } from "./blocks";
import { followableAt, taskMarkerAt } from "./livePreview";
import { barFaceOf } from "../lib/nativeBridge";
import { keepsSelection, type EditorClickContext } from "../commands/editorMenu";

/**
 * The element the pointer is really over.
 *
 * The link layer is parented to the body, and its invisible
 * `pointer-events: auto` hotspots sit over every rendered link, wikilink, tag
 * and checkbox (livePreview.ts). A right-click on one lands outside the editor,
 * so without looking through, the menu would not open on the four clicks it has
 * the most to say about (interactions.md §11). targetUnder looks through that
 * layer and nothing else: a block's run and copy buttons keep their own gesture.
 */
export function targetUnder(target: Element | null, x: number, y: number): Element | null {
  if (!target?.closest(".ledge-linklayer")) return target;
  return document.elementsFromPoint(x, y).find((el) => !el.closest(".ledge-linklayer")) ?? null;
}

/**
 * Prepares `view` for a menu about to open over `el` at (x, y), and answers
 * what the menu should carry. Null means no menu: the click was not on this
 * note's text.
 *
 * `barFaceOf` (lib/nativeBridge.ts) decides whether `el` is in the note, the
 * same test it runs for the accessory bar. A run's output panel is a block
 * widget inside `.cm-content` and is not the note (interactions.md §11), so a
 * right-click there keeps meaning what it means in the panel, which is nothing
 * so far. Otherwise Copy would act on the selection in the note behind it.
 */
export function prepareEditorMenu(
  view: EditorView,
  el: Element | null,
  x: number,
  y: number,
  readOnly: boolean,
): EditorClickContext | null {
  if (!el || !view.dom.contains(el) || barFaceOf(el) !== "note") return null;
  // The `false` asks posAtCoords for the nearest position rather than an exact
  // one. A click in the empty space under a short note is still a click in the
  // note, and clamping is what makes pasting at the end work there. The precise
  // form answers null there.
  const pos = view.posAtCoords({ x, y }, false);
  if (!keepsSelection(view.state.selection.ranges, pos)) {
    view.dispatch({ selection: { anchor: pos } });
  }
  // The click focuses the editor, the way any other click in it does. The
  // menu's items refocus before they act (commands/glue.ts withView), but the
  // caret has just moved and is invisible while the editor is unfocused. Focus
  // also means the next keystroke after the menu closes lands in this note.
  view.focus();
  return {
    onLink: followableAt(view.state, pos) !== null,
    onTask: taskMarkerAt(view.state, pos) !== null,
    onRunnableBlock: runnableBlockAt(view.state, pos),
    readOnly,
  };
}
