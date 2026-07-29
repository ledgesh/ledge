// Shift+Enter inside a list item continues it on a line indented under the
// item's TEXT, not under its marker.
//
// Upstream gives Shift+Enter to CodeMirror's insertNewlineAndIndent (the
// `shift` half of defaultKeymap's Enter binding), which reindents to the
// line's own indentation — for `- foo` that is column 0, so the new line lands
// under the dash and markdown no longer reads it as part of the item. The
// damage shows up on the NEXT Enter: the parser has an ordinary paragraph
// where the item's second line should be, so the list stops continuing, and
// for ordered items insertNewlineContinueMarkup deletes the orphaned line
// outright. Indenting to the item's content column fixes both at the source —
// the continuation stays inside the ListItem, so every later Enter sees the
// list it is standing in.
//
// Two paired Enter bindings follow, both about lines the item has already
// continued onto — Enter on the item's FIRST line is untouched, since that is
// where "next item" lives and upstream inserts the marker for it.
// exitListContinuation is the way out: an indent-only line is what a
// Shift+Enter you changed your mind about leaves behind, and upstream's Enter
// pushes the whitespace DOWN (newline first, indent still trailing under the
// caret) rather than clearing it, so this clears the line and leaves the caret
// on it — the one-press exit quotes.ts gives blockquotes. continueListBody is
// the way on, and exists for task items specifically: see its own comment.
import type { SyntaxNode } from "@lezer/common";
import {
  EditorSelection,
  Prec,
  type EditorState,
  type StateCommand,
  type Transaction,
} from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { keymap } from "@codemirror/view";
import { insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";

// A list item's opening run: indent (group 1, which may carry blockquote
// markers — a list inside a quote is still a list), the bullet or ordered
// marker, and the space after it. CommonMark's ordered markers cap at 9
// digits; a marker with no space after it is not a marker.
//
// A task item's `[ ]` is deliberately NOT part of the run. It is the item's
// content, not its marker — the content column of `- [ ] foo` is still 2 —
// and under live preview the box draws as one compact glyph, so indenting
// past the four raw characters would step the continuation visibly further
// right than the text it belongs to.
const MARKER = /^([ \t]*(?:>[ \t]*)*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/**
 * The whitespace that puts a new line under `lineText`'s item content — the
 * marker run turned into blanks — or null when the line opens no list item.
 * The prefix is copied verbatim so a tab-indented list keeps its own
 * indentation unit and a quoted list keeps its `>`; only the list marker
 * itself becomes blanks. Pure, so the column arithmetic is testable line by
 * line.
 */
export function listContentIndent(lineText: string): string | null {
  const m = MARKER.exec(lineText);
  return m ? m[1]! + m[0].slice(m[1]!.length).replace(/[^\t]/g, " ") : null;
}

/**
 * Whether a line is indentation and nothing else — the abandoned continuation
 * Enter should clear. An empty line is not one: it is already the exit.
 */
export function isIndentOnly(lineText: string): boolean {
  return /^[ \t]+$/.test(lineText.replace(/\r$/, ""));
}

// A block INSIDE a list item that owns its own line grammar: its Enter and its
// indentation are that block's business, not the item's. The walk below stops
// on these, so a fenced block's `- ` stays code and a quote nested in an item
// keeps getting its `> ` from upstream. A NESTED list needs no entry: walking
// out from the caret reaches the inner ListItem before its list.
const NOT_ITEM_TEXT = new Set(["FencedCode", "CodeBlock", "Blockquote", "Table", "HTMLBlock"]);

// The innermost ListItem `pos` sits in as ordinary item text, or null.
// ensureSyntaxTree, not syntaxTree, for quotes.ts's reason: this runs between
// two fast keystrokes and a stale tree reads as "not a list".
function listItemAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, pos, 50);
  if (!tree) return null;
  for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === "ListItem") return n;
    if (NOT_ITEM_TEXT.has(n.name)) return null;
  }
  return null;
}

// The indent that continues the item `pos` sits in, or null when it sits in no
// item. Read from the ITEM's first line, since the caret may already be on a
// continuation; `firstLine` reports whether it is, which is the whole
// difference between the two bindings below.
function continuation(
  state: EditorState,
  pos: number,
): { indent: string; firstLine: boolean } | null {
  const item = listItemAt(state, pos);
  if (!item) return null;
  const open = state.doc.lineAt(item.from);
  const indent = listContentIndent(open.text);
  if (indent === null) return null;
  return { indent, firstLine: open.number === state.doc.lineAt(pos).number };
}

// Newline + `indents[head]` at every caret. Shared by both bindings: they
// differ only in which carets they accept.
function insertContinuation(
  state: EditorState,
  dispatch: (tr: any) => void,
  indents: Map<number, string>,
): boolean {
  if (indents.size === 0) return false;
  dispatch(
    state.update(
      state.changeByRange((range) => {
        const insert = `\n${indents.get(range.head)!}`;
        return {
          changes: { from: range.head, insert },
          range: EditorSelection.cursor(range.head + insert.length),
        };
      }),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
  return true;
}

/**
 * The Shift+Enter binding: newline plus the enclosing item's content indent,
 * from anywhere in the item. Falls through (false) outside a list item, in
 * code, and on any non-empty selection, so the ordinary soft-newline machinery
 * runs there.
 */
export const continueListItem: StateCommand = ({ state, dispatch }) => {
  const indents = new Map<number, string>();
  for (const range of state.selection.ranges) {
    if (!range.empty) return false;
    // Precomputed per range before any change lands: the tree can only answer
    // against the current doc.
    const cont = continuation(state, range.head);
    if (!cont) return false;
    indents.set(range.head, cont.indent);
  }
  return insertContinuation(state, dispatch, indents);
};

/**
 * The Enter binding for a line the item already continues onto: another line
 * at the same indent. Upstream mostly agrees — but for a TASK item it measures
 * emptiness from past the `[ ]`, so a continuation indented to the bullet
 * (which is where it belongs: the checkbox is content, not marker) reads as an
 * empty item and Enter DELETES the item's text. Owning the case keeps the two
 * keys telling the same story. The item's FIRST line stays upstream's: that is
 * where Enter means "next item", and inserting the marker is its job.
 */
export const continueListBody: StateCommand = ({ state, dispatch }) => {
  const indents = new Map<number, string>();
  for (const range of state.selection.ranges) {
    if (!range.empty) return false;
    const cont = continuation(state, range.head);
    if (!cont || cont.firstLine) return false;
    indents.set(range.head, cont.indent);
  }
  return insertContinuation(state, dispatch, indents);
};

/**
 * The Enter binding: on an indent-only line directly under a list item, clear
 * the line rather than pushing its whitespace ahead of the caret. Everything
 * else falls through — including a marker-only line, which is upstream's own
 * empty-item case and stays upstream's.
 */
export const exitListContinuation: StateCommand = ({ state, dispatch }) => {
  const clear: { from: number; to: number }[] = [];
  for (const range of state.selection.ranges) {
    if (!range.empty) return false;
    const line = state.doc.lineAt(range.head);
    if (line.number === 1 || !isIndentOnly(line.text)) return false;
    // The line itself is blank, so the parser parents it to the Document, not
    // to the item it trails; the line ABOVE is what says a list is open here.
    if (!listItemAt(state, state.doc.line(line.number - 1).to)) return false;
    clear.push({ from: line.from, to: line.to });
  }
  if (clear.length === 0) return false;
  dispatch(state.update({ changes: clear, userEvent: "delete" }));
  return true;
};

export function listContinuation() {
  return Prec.high(
    keymap.of([
      { key: "Shift-Enter", run: continueListItem },
      // Order matters: an indent-only continuation is the exit, not one more
      // line of it.
      { key: "Enter", run: exitListContinuation },
      { key: "Enter", run: continueListBody },
    ]),
  );
}

// Upstream's Enter with its first loose-list branch switched off by config:
// Enter on an empty `- ` now always LEAVES the list. Without this it does,
// except in one shape — a TIGHT list of exactly two items whose second is
// that empty marker, where it pushes the marker down a line to make the list
// loose instead. That shape is what the end of a note gives you (one real
// item plus the marker you just opened), which is why the stray blank line
// appeared only there: one more item above and the exit branch wins already.
const markupCommand = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/**
 * Upstream's Enter again, minus the blank line it prepends when the list is
 * ALREADY loose. That is its second looseness rule and has no config: given
 * `- a` / `` / `- b`, Enter on `b` inserts `\n\n- `, propagating the blank
 * spacing to every item you go on to type. One blank line is how you leave a
 * list and start a new one, so in practice every list written under an
 * earlier one inherits double spacing forever.
 *
 * Suppressing it costs nothing that renders: looseness is a property of the
 * WHOLE list, so a tight item added to a loose list leaves the HTML exactly
 * as it was, and Ledge's live preview draws neither differently. What it buys
 * is Enter meaning one thing — the next item, on the next line.
 *
 * Done by trimming upstream's own output rather than reimplementing it: the
 * insertion is always `\n` + the blank line + `\n` + the marker, so keeping it
 * from its LAST line break drops the blank and nothing else. Marker choice,
 * nesting indent, and ordered-list renumbering stay upstream's, which is the
 * point — those are the parts worth not owning.
 */
export const continueMarkup: StateCommand = ({ state, dispatch }) => {
  let out: Transaction | undefined;
  if (!markupCommand({ state, dispatch: (tr) => (out = tr) })) return false;
  const tr = out!;
  // One caret only: with several, "the" insertion is not a single thing to
  // trim, and upstream's result — blank lines and all — is still correct.
  if (state.selection.ranges.length !== 1) {
    dispatch(tr);
    return true;
  }

  const specs: { from: number; to: number; insert: string }[] = [];
  // The change that opens the new line, once trimmed. An ordered list also
  // renumbers, which is why this is a scan and not an assumption about count.
  let opener: { from: number; length: number } | null = null;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let text = inserted.toString();
    const blank = text.lastIndexOf(state.lineBreak);
    if (blank > 0) {
      text = text.slice(blank);
      opener = { from: fromA, length: text.length };
    }
    specs.push({ from: fromA, to: toA, insert: text });
  });
  if (!opener) {
    dispatch(tr);
    return true;
  }

  const changes = state.changes(specs);
  const { from, length } = opener as { from: number; length: number };
  dispatch(
    state.update({
      changes,
      // mapPos with assoc -1 lands at the START of the insertion (past any
      // renumbering above it); the caret goes at its end, on the new marker.
      selection: EditorSelection.cursor(changes.mapPos(from, -1) + length),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/**
 * Ships as its own extension because of where it has to sit: ahead of
 * markdown()'s keymap (that is the binding it displaces) but BEHIND
 * fenceClose(), which owns Enter at the end of a fence opener — including one
 * inside a list item, which this command would happily answer first.
 */
export function tightLists() {
  return Prec.high(keymap.of([{ key: "Enter", run: continueMarkup }]));
}
