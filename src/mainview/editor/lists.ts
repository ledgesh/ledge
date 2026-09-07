// Shift+Enter inside a list item continues it on a line indented under the
// item's text, not under its marker (interactions.md §3).
//
// Upstream binds Shift+Enter to CodeMirror's insertNewlineAndIndent (the
// `shift` half of defaultKeymap's Enter binding), which reindents to the
// line's own indentation. For `- foo` that is column 0, so the new line lands
// under the dash and markdown stops reading it as part of the item. The damage
// shows on the next Enter. The parser has an ordinary paragraph where the
// item's second line should be, so the list stops continuing. For ordered
// items insertNewlineContinueMarkup deletes the orphaned line. Indenting to
// the item's content column fixes both failures, because the continuation
// stays inside the ListItem.
//
// Two Enter bindings follow, both for lines the item has already continued
// onto. Enter on the item's first line is untouched: that is where "next item"
// lives, and upstream inserts the marker for it. exitListContinuation takes
// the indent-only line an abandoned Shift+Enter leaves behind, clearing the
// line and leaving the caret on it, the one-press exit quotes.ts gives
// blockquotes. Upstream's Enter would push that whitespace down instead
// (newline first, indent still trailing under the caret). continueListBody
// takes the other continuation lines, and exists for task items specifically
// (see its own comment).
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

// A list item's opening run: the indent (group 1), the bullet or ordered
// marker, and the space after it. The indent may carry blockquote markers,
// since a list inside a quote is still a list. CommonMark caps ordered markers
// at 9 digits; a marker with no space after it is not a marker.
//
// A task item's `[ ]` is not part of the run. It is content, so the content
// column of `- [ ] foo` is still 2. Live preview draws the box as one compact
// glyph (livePreview.ts). Indenting past the four raw characters would put the
// continuation visibly right of the text it belongs to.
const MARKER = /^([ \t]*(?:>[ \t]*)*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/**
 * The whitespace that puts a new line under `lineText`'s item content: the
 * marker run turned into blanks. Null when the line opens no list item. The
 * prefix is copied verbatim, so a tab-indented list keeps its indentation
 * unit and a quoted list keeps its `>`. Pure, so the column arithmetic is
 * testable line by line.
 */
export function listContentIndent(lineText: string): string | null {
  const m = MARKER.exec(lineText);
  return m ? m[1]! + m[0].slice(m[1]!.length).replace(/[^\t]/g, " ") : null;
}

/**
 * Whether a line is indentation and nothing else: the abandoned continuation
 * Enter should clear. An empty line does not count, since it is already the
 * exit.
 */
export function isIndentOnly(lineText: string): boolean {
  return /^[ \t]+$/.test(lineText.replace(/\r$/, ""));
}

// Blocks inside a list item that own their own line grammar: their Enter and
// their indentation belong to the block, not to the item. The walk below stops
// on these, so a fenced block's `- ` stays code and a quote nested in an item
// keeps getting its `> ` from upstream. A nested list needs no entry: walking
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
// item. The indent comes from the item's first line, since the caret may
// already be on a continuation. `firstLine` is true when the caret is on that
// opening line, the only difference between the two bindings below.
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
 * at the same indent. It runs on the continuation line of any list item, so
 * Enter and Shift+Enter indent a continuation the same way. Upstream agrees,
 * except on a task item, where it measures emptiness from past the `[ ]`. A
 * continuation indented to the bullet then reads as an empty item, and Enter
 * deletes the item's text. The checkbox is content, not marker, so the bullet
 * is where that continuation belongs. The item's first line stays upstream's,
 * where Enter means "next item" and inserting the marker is its job.
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
 * else falls through, including a marker-only line. That is upstream's own
 * empty-item case and stays upstream's.
 */
export const exitListContinuation: StateCommand = ({ state, dispatch }) => {
  const clear: { from: number; to: number }[] = [];
  for (const range of state.selection.ranges) {
    if (!range.empty) return false;
    const line = state.doc.lineAt(range.head);
    if (line.number === 1 || !isIndentOnly(line.text)) return false;
    // The line itself is blank, so the parser parents it to the Document, not
    // to the item it trails. The line above is what says a list is open here.
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
// Enter on an empty `- ` now always leaves the list. Without the config it
// leaves in every shape but one: a tight list of exactly two items whose
// second is that empty marker, where it pushes the marker down a line to make
// the list loose instead. A list typed at the end of a note lands in that
// shape (one real item plus the marker just opened), so the stray blank line
// appeared only there. With one more item above, the exit branch already wins.
const markupCommand = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/**
 * Upstream's Enter again, minus the blank line it prepends when the list is
 * already loose. That is its second looseness rule and has no config: given
 * `- a` / `` / `- b`, Enter on `b` inserts `\n\n- `, and every item typed
 * after that inherits the blank spacing. One blank line is also how a list
 * ends and a new one starts, so every list written under an earlier one is
 * double spaced from then on.
 *
 * Suppressing the blank changes nothing that renders. Looseness is a property
 * of the whole list, so a tight item added to a loose list leaves the HTML as
 * it was, and Ledge's live preview draws a tight item and a loose one alike
 * (interactions.md §3).
 *
 * This command trims upstream's own output instead of reimplementing it. The
 * insertion is always `\n` + the blank line + `\n` + the marker, so keeping it
 * from its last line break drops the blank and nothing else. Marker choice,
 * nesting indent, and ordered-list renumbering stay upstream's.
 */
export const continueMarkup: StateCommand = ({ state, dispatch }) => {
  let out: Transaction | undefined;
  if (!markupCommand({ state, dispatch: (tr) => (out = tr) })) return false;
  const tr = out!;
  // One caret only: with several there is no single insertion to trim, and
  // upstream's result, blank lines included, is still correct.
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
      // mapPos with assoc -1 lands at the start of the insertion, past any
      // renumbering above it. The caret goes at its end, on the new marker.
      selection: EditorSelection.cursor(changes.mapPos(from, -1) + length),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/**
 * Ships as its own extension for where it has to sit: ahead of markdown()'s
 * keymap, whose Enter binding it displaces, and behind fenceClose(), which
 * owns Enter at the end of a fence opener. That includes a fence opener
 * inside a list item, which this command would otherwise answer first.
 */
export function tightLists() {
  return Prec.high(keymap.of([{ key: "Enter", run: continueMarkup }]));
}
