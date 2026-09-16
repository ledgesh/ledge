// Where a mouse click landed in the text, for the editor's click handlers
// that follow a link instead of moving the caret (interactions.md §3, Open Link).
import type { EditorView } from "@codemirror/view";

/**
 * The document position a click at `x`/`y` sits on, or null when the click
 * was beside the text rather than on it. `posAtCoords` clamps: a click
 * anywhere in the blank to the right of a line answers with that line's last
 * position, so a handler reading it alone follows a link ending the line from
 * anywhere out to the window edge. The caret rectangle at the position says
 * where the text really is, and a click on a glyph resolves to a boundary
 * within one character of it.
 */
export function textPosAtCoords(view: EditorView, x: number, y: number): number | null {
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return null;
  const slack = view.defaultCharacterWidth;
  // Both sides: a position on a line-wrap boundary has two rectangles, the
  // end of one row and the start of the next.
  for (const side of [-1, 1] as const) {
    const c = view.coordsAtPos(pos, side);
    if (!c) continue;
    if (x >= c.left - slack && x <= c.right + slack && y >= c.top && y <= c.bottom) return pos;
  }
  return null;
}
