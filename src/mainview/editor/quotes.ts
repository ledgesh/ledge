// Enter on an empty blockquote line exits the quote.
//
// Upstream (@codemirror/lang-markdown's insertNewlineContinueMarkup, the
// markdown() Enter binding) gives lists this: Enter on an empty item deletes
// the marker. Blockquotes never got that path — Enter on an empty `> ` line
// inserts ANOTHER `> ` (normalizing the current line to a bare `>` on the
// way, which is the mismatched-markers look), and the only way out is two
// aligned empty quote lines plus a third Enter that then strips both without
// even inserting a newline. This binding closes the gap: one Enter on a
// marker-only quote line clears the line and leaves the caret on it, exactly
// the list feel. It runs at the same Prec.high as markdown's own keymap and
// is registered ahead of it (setup.ts), so it wins only the case it handles
// and falls through (returns false) everywhere else.
import type { SyntaxNode } from "@lezer/common";
import { Prec, type StateCommand } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { keymap } from "@codemirror/view";

/**
 * Whether a line is nothing but blockquote markers and whitespace — the
 * "empty quoted line" Enter should exit from. Pure, so the shape of the rule
 * is testable without an editor; the caller still owns asking the parser
 * whether the line really sits in a Blockquote (a `> ` inside a code fence
 * matches this regex but is code, not quote).
 */
export function isQuoteMarkerOnly(lineText: string): boolean {
  return /^[ \t]*>(?:[ \t]*>)*[ \t]*$/.test(lineText.replace(/\r$/, ""));
}

// A StateCommand (not an EditorView command) so the whole behavior — not
// just the line predicate — is testable headlessly (quotes.test.ts).
export const exitQuote: StateCommand = ({ state, dispatch }) => {
  const clear = new Map<number, { from: number; to: number }>();
  for (const range of state.selection.ranges) {
    if (!range.empty) return false;
    const line = state.doc.lineAt(range.head);
    if (!isQuoteMarkerOnly(line.text)) return false;
    // ensureSyntaxTree, not syntaxTree: this runs between two fast Enters,
    // and the incremental parse may not have reached the just-typed line —
    // a stale tree here reads as "not a quote" and silently falls through to
    // the upstream behavior this module exists to replace. Forcing the parse
    // up to the caret's line is trivially cheap at note sizes; a doc so big
    // the budget fails degrades to upstream, never breaks.
    const tree = ensureSyntaxTree(state, line.to, 50);
    if (!tree) return false;
    let quoted = false;
    for (let n: SyntaxNode | null = tree.resolveInner(range.head, -1); n; n = n.parent) {
      if (n.name === "Blockquote") {
        quoted = true;
        break;
      }
      if (n.name === "FencedCode" || n.name === "CodeBlock") break;
    }
    if (!quoted) return false;
    clear.set(line.from, { from: line.from, to: line.to });
  }
  if (clear.size === 0) return false;
  dispatch(state.update({ changes: [...clear.values()], userEvent: "delete" }));
  return true;
};

export function quoteExit() {
  return Prec.high(keymap.of([{ key: "Enter", run: exitQuote }]));
}
