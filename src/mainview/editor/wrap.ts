import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// The column where a line's content begins: its leading whitespace plus any
// Markdown list / ordered / blockquote markers that precede the text. This is
// what a wrapped continuation row should hang-indent to, so the second visual
// row lines up under the content rather than snapping back to column 0.
//
// A marker only counts when whitespace follows it, matching Markdown's own rule
// ("- x" is a bullet, "-x" and a lone "---" are not). Headings (#) are left at 0
// on purpose: their text is a larger font, so a ch-based hang would misalign, and
// wrapped headings read fine flush-left.
//
// Measured in characters. The editor is monospace, so one character is one `ch`,
// which is what the decoration below uses. Tabs count as one column (rare in
// notes; not worth expanding here).
const INDENT_RE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|>)[ \t]+)*/;

export function hangingIndentCols(lineText: string): number {
  const m = INDENT_RE.exec(lineText);
  return m ? m[0].length : 0;
}

// A line decoration per visible line that hangs its wrapped rows under the
// content column: `padding-left` shifts the whole line right by N columns, and a
// matching negative `text-indent` pulls the first row back to 0, so only the
// wrapped continuation rows keep the indent.
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
          Decoration.line({ attributes: { style: `text-indent:-${n}ch;padding-left:${n}ch` } }),
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

// Soft-wrap long lines (prose and code fences alike) and hang wrapped rows under
// their content column. Global wrap is the right default for a notes editor:
// horizontal scrolling loses text off the right edge, which a note should never do.
export function wrapping() {
  return [EditorView.lineWrapping, hangingIndent];
}
