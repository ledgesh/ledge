// A lone `-` under a paragraph is not styled as a heading while the caret sits
// on it. CommonMark reads that dash as a Setext underline, so
//
//     This is a regular line
//     -
//
// is an H2. The dash is also the first keystroke of a bullet list. Opening one
// under a paragraph restyles the prose above as a big bold heading, and it
// stays that way until enough of the item is typed. The text is fine
// throughout and only the rendering lurches. fences.ts describes the same
// restyling and answers it the same way: do not show the in-between moment.
//
// While the caret is on the dash, the heading styling stays off every line the
// heading spans. Nothing about the text changes and nothing is hidden. Move
// the caret away and the heading draws, because then an H2 is what the file
// says. The rule stays narrow so it cannot withhold styling from a heading
// someone meant: `--`, `---` and `=` are underlines nobody types on the way to
// a list, so they are never touched, and neither is a `-` the caret is not on.
// The full grammar is interactions.md §3, the "Pending Setext" row.
//
// setup.ts registers nascentBullet() unconditionally, not behind the
// livePreview setting. This is not concealment: it withholds a style from a
// heading that does not exist yet, and raw Markdown styles its headings too
// and lurches the same way.
import type { SyntaxNode } from "@lezer/common";
import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * Whether a line is a lone `-`, the one Setext underline that is also how a
 * bullet list starts. Two dashes or more is an underline someone meant, and a
 * dash with content after it is already a list item, so neither matches. Pure,
 * so the rule is testable line by line.
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

  // Only a dash the parser read as a heading. ensureSyntaxTree rather than
  // syntaxTree for quotes.ts's reason: this runs a keystroke after the dash
  // landed, and the incremental parse may not have reached it yet. A stale
  // tree reads as "no heading", which leaves upstream's rendering alone.
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

  // The heading node spans the paragraph and its underline, and the paragraph
  // itself may run to several lines. Every line the node covers draws large
  // and bold, so every one gets the pending class.
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
      // selectionSet matters as much as docChanged: moving the caret off the
      // dash is what restores the heading styling.
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
