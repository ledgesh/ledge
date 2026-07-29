// A list marker being typed under a paragraph is not a heading yet.
//
// `-` on the line below a paragraph is a Setext underline: CommonMark reads
//
//     This is a regular line
//     -
//
// as an H2, and the parser is right to. But that is also the first keystroke
// of every bullet list written under a paragraph, so opening one restyles the
// prose above as a big bold heading, and it stays that way until enough of the
// item is typed to stop looking like an underline. The document is fine
// throughout; only the rendering lurches — fences.ts's complaint, and the same
// answer: the in-between moment should not be shown.
//
// So while the caret sits on a lone `-`, the heading styling is suppressed on
// both lines the heading spans. Nothing about the text changes, and nothing is
// hidden: move the caret away and the heading draws, because at that point an
// H2 is genuinely what the file says. The narrowness is the safety — `--`,
// `---`, and `=` are underlines nobody types by accident on the way to a list,
// so they are never touched, and neither is a `-` the caret is not on.
//
// Not gated by the livePreview setting. This is not concealment (raw markdown
// styles its headings too, and lurches identically); it is a style not applied
// to a construct that does not exist yet.
import type { SyntaxNode } from "@lezer/common";
import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * Whether a line is a lone `-` — the one Setext underline that is also how a
 * bullet list starts. `--` and longer are left alone: past the first dash the
 * underline is deliberate. Pure, so the rule is testable line by line.
 */
export function isNascentBullet(lineText: string): boolean {
  return /^[ \t]*-[ \t]*$/.test(lineText.replace(/\r$/, ""));
}

const PENDING = Decoration.line({ class: "ledge-setext-pending" });

function build(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty) return builder.finish();
  const line = state.doc.lineAt(range.head);
  if (!isNascentBullet(line.text)) return builder.finish();

  // Only a dash the parser actually made a heading out of. ensureSyntaxTree
  // for quotes.ts's reason: this runs a keystroke after the dash landed, and a
  // stale tree reads as "no heading" — which is the safe way to be wrong here,
  // since it just leaves upstream's rendering alone.
  const tree = ensureSyntaxTree(state, line.to, 50);
  if (!tree) return builder.finish();
  let heading: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = tree.resolveInner(line.from, 1); n; n = n.parent) {
    if (n.name === "SetextHeading1" || n.name === "SetextHeading2") {
      heading = n;
      break;
    }
  }
  if (!heading) return builder.finish();

  // The heading is the paragraph AND its underline; both draw large and bold.
  const first = state.doc.lineAt(heading.from).number;
  const last = state.doc.lineAt(heading.to).number;
  for (let n = first; n <= last; n++) {
    const at = state.doc.line(n);
    builder.add(at.from, at.from, PENDING);
  }
  return builder.finish();
}

const pendingSetext = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: { state: EditorState }) {
      this.decorations = build(view.state);
    }
    update(u: ViewUpdate) {
      // selectionSet as much as docChanged: moving the caret off the dash is
      // what makes the heading real.
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = build(u.state);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export function nascentBullet() {
  return pendingSetext;
}
