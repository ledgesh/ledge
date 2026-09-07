// Enter on an empty blockquote line exits the quote (interactions.md §3).
//
// Upstream does this for lists, not blockquotes. @codemirror/lang-markdown's
// Enter binding (insertNewlineContinueMarkup) deletes the marker on an empty
// list item. Enter on an empty `> ` line inserts another `> ` and rewrites
// the current line to a bare `>`. The markers no longer line up. The only way
// out upstream is two aligned empty quote lines plus a third Enter. That
// Enter strips both markers and inserts no newline. This binding clears a
// marker-only quote line on the first Enter and leaves the caret there, the
// one press a list already gets. It runs at the same Prec.high as markdown's
// keymap and is registered ahead of it (setup.ts). It wins only the case it
// handles and returns false everywhere else.
import type { SyntaxNode } from "@lezer/common";
import { Prec, type StateCommand } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { keymap } from "@codemirror/view";

/**
 * Whether a line holds nothing but blockquote markers and whitespace. That is
 * the empty quoted line that Enter exits from. The function is pure, so the
 * rule is testable without an editor. The caller still asks the parser
 * whether the line really sits in a Blockquote: a `> ` inside a code fence
 * matches this regex but is code, not quote.
 */
export function isQuoteMarkerOnly(lineText: string): boolean {
  return /^[ \t]*>(?:[ \t]*>)*[ \t]*$/.test(lineText.replace(/\r$/, ""));
}

// A StateCommand, not an EditorView command, so the whole behavior, not just
// the line predicate, is testable headlessly (quotes.test.ts).
export const exitQuote: StateCommand = ({ state, dispatch }) => {
  const clear = new Map<number, { from: number; to: number }>();
  for (const range of state.selection.ranges) {
    if (!range.empty) return false;
    const line = state.doc.lineAt(range.head);
    if (!isQuoteMarkerOnly(line.text)) return false;
    // ensureSyntaxTree, not syntaxTree: this runs between two fast Enters and
    // the incremental parse may not have reached the just-typed line. A stale
    // tree reads as "not a quote" and falls through silently to the upstream
    // behavior this module replaces. Parsing up to the caret's line is cheap
    // at note sizes. A doc too big for the 50ms budget falls through too.
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
