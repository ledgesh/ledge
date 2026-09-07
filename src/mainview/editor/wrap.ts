import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// The column where a line's content begins: leading whitespace plus any
// bullet, ordered-list, or blockquote markers before the text. Wrapped
// continuation rows line up at this column instead of going back to column
// 0. A marker counts only when whitespace follows it, matching Markdown's
// own rule ("- x" is a bullet, "-x" and a lone "---" are not).
//
// Headings (#) are left at column 0. setup.ts sizes h1 to h4 up, so a
// ch-based hang would misalign them. Wrapped headings read fine flush-left.
//
// The count is in characters. The editor is monospace, so one character is
// one `ch`, the unit the decoration below uses. A tab counts as one column:
// tabs are rare in notes, so nothing here expands them to a tab stop.
const INDENT_RE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|>)[ \t]+)*/;

export function hangingIndentCols(lineText: string): number {
  const m = INDENT_RE.exec(lineText);
  return m ? m[0].length : 0;
}

// Hangs wrapped rows under the content column. `margin-left` shifts a line
// right by N columns. A matching negative `text-indent` pulls its first row
// back to column 0, so only the wrapped rows keep the indent. Each visible
// line with a nonzero hang gets one decoration.
//
// The decoration sets margin, not padding. CodeMirror's base theme gives
// .cm-line a small padding-left, and an inline padding replaces it rather
// than adding to it: list lines lose those pixels, and the marker sits left
// of where plain prose starts. Margin composes with the base padding.
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const n = hangingIndentCols(line.text);
      if (n > 0) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ attributes: { style: `text-indent:-${n}ch;margin-left:${n}ch` } }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Soft-wrap long lines (prose and code fences alike) and hang wrapped rows
// under their content column. Without wrapping the editor scrolls
// horizontally, and part of a note sits out of view past the right edge.
// `EditorView.lineWrapping` applies to the whole document.
export function wrapping() {
  return [EditorView.lineWrapping, hangingIndent];
}
