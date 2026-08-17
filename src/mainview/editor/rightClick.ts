// What a right-click in a note does before its menu opens (interactions.md
// §11): it places the caret, then reports what it landed on so the spec
// (commands/editorMenu.ts) can decide which verbs to carry.
//
// Pointer-only, and deliberately so. The gesture a finger would use here is
// the one iOS spends on selecting text, and the callout it raises already
// carries cut/copy/paste/define for the platform — a long press that opened
// our menu instead would take the selection gesture away and give back less.
// The row menus' long press (lib/useRowMenu.ts) exists because a row has no
// other way to its verbs; the editor's verbs are all in the palette and, on a
// phone, on the accessory bar (§1a).
import type { EditorView } from "@codemirror/view";
import { runnableBlockAt } from "./blocks";
import { followableAt, taskMarkerAt } from "./livePreview";
import { barFaceOf } from "../lib/nativeBridge";
import { keepsSelection, type EditorClickContext } from "../commands/editorMenu";

/**
 * The element the pointer is really over.
 *
 * The link layer floats an invisible `pointer-events: auto` hotspot over every
 * rendered link, wikilink, tag and checkbox (livePreview.ts) — parented to the
 * body, because the WKWebView will not honour `cursor` inside the editing
 * context. So a right-click on any of them has a target OUTSIDE the editor
 * entirely, and those are exactly the things this menu's first group is about:
 * without looking through, the menu would refuse to open in the four places it
 * has the most to say. The layer is the only thing looked through; a block's
 * run and copy buttons are aimed at deliberately and keep their own gesture.
 */
export function targetUnder(target: Element | null, x: number, y: number): Element | null {
  if (!target?.closest(".ledge-linklayer")) return target;
  return document.elementsFromPoint(x, y).find((el) => !el.closest(".ledge-linklayer")) ?? null;
}

/**
 * Prepare `view` for a menu about to open over `el` at (x, y), and answer what
 * the menu should carry. Null means no menu: the click was not on this note's
 * text at all.
 *
 * `barFaceOf` is what draws that line, because it already draws exactly this
 * one for the accessory bar (lib/nativeBridge.ts): a run's output panel is a
 * block widget INSIDE `.cm-content`, so "in the editor" is not the same
 * question as "in the note". A right-click in a run panel keeps meaning what
 * it means there — nothing, so far — rather than offering Copy for a selection
 * in the note behind it.
 */
export function prepareEditorMenu(
  view: EditorView,
  el: Element | null,
  x: number,
  y: number,
  readOnly: boolean,
): EditorClickContext | null {
  if (!el || !view.dom.contains(el) || barFaceOf(el) !== "note") return null;
  // Imprecise on purpose: a click in the empty space under a short note is a
  // right-click in the note, and clamping it to the nearest position is what
  // makes "paste at the end" work. The precise form answers null there.
  const pos = view.posAtCoords({ x, y }, false);
  if (!keepsSelection(view.state.selection.ranges, pos)) {
    view.dispatch({ selection: { anchor: pos } });
  }
  // The click focuses the editor like any other click in it: the menu's own
  // items refocus before they act (commands/glue.ts withView), but the caret
  // just moved and a caret in an unfocused editor is invisible — and whatever
  // the user reaches for after dismissing the menu should land here too.
  view.focus();
  return {
    onLink: followableAt(view.state, pos) !== null,
    onTask: taskMarkerAt(view.state, pos) !== null,
    onRunnableBlock: runnableBlockAt(view.state, pos),
    readOnly,
  };
}
