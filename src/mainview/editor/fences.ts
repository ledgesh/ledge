// An unterminated fence closes itself — on the mark that completes the opener,
// and on Enter.
//
// Typing `---` on line 1 (frontmatter) or ```lang anywhere (code) has an ugly
// in-between moment: until the closing fence exists, the parser reads the rest
// of the note as the fence's inside — everything below the caret dims or
// restyles as code mid-gesture. Where a block already sits below, it is worse
// than cosmetic: THAT block's closing fence pairs with the new opener instead,
// and the block between them, its own opening fence included, becomes content
// of the one being typed. Bracket-autoclose semantics fix it. The third
// backtick (or tilde) plants the matching closer on the next line and leaves
// the caret where it was, so the info string still gets typed and the merged
// state never exists at all.
//
// Enter is the other half, for the openers typing never sees: a line-1 `---`
// (three dashes are a thematic break or a Setext rule everywhere else, so only
// the Enter that commits the line can read them as frontmatter), a pasted
// opener, an opener whose closer was deleted. It inserts the closing fence and
// leaves the caret on the empty line between. Both halves act on the
// UNTERMINATED case only: on the opener of a block that already has an end,
// Enter is an ordinary newline and a typed mark is an ordinary mark.
//
// Fence pairing here is the text scan, not the syntax tree: the decision runs
// between two fast keystrokes (quotes.ts's timing problem), and what it needs
// — is some earlier fence still open, does any later line close this one — is
// a line walk both ends of the app already agree on, not a parse.
import {
  Prec,
  type EditorState,
  type StateCommand,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { frontmatterEnd } from "../../shared/frontmatter";

// The frontmatter opener, shared/frontmatter.ts's FENCE: exactly three
// dashes, trailing blanks (and a pasted \r) tolerated.
const FM_FENCE = /^---[ \t\r]*$/;

// A code-fence opener per CommonMark: up to 3 spaces of indent, then ``` or
// ~~~ (3+ marks), then an info string — which may not contain a backtick for
// backtick fences (` ```js`` ` is not a fence).
const OPEN_TICK = /^( {0,3})(`{3,})([^`]*)$/;
const OPEN_TILDE = /^( {0,3})(~{3,})(.*)$/;

/**
 * The line's code-fence opener shape — its indent and fence marks — or null.
 * Pure so the grammar is testable line by line.
 */
export function fenceOpener(lineText: string): { indent: string; marker: string } | null {
  const m = OPEN_TICK.exec(lineText) ?? OPEN_TILDE.exec(lineText);
  return m ? { indent: m[1]!, marker: m[2]! } : null;
}

/**
 * Whether a line closes a fence opened with `marker`: the same character, at
 * least as many of them, nothing but blanks after (a close fence carries no
 * info string).
 */
export function fenceCloser(lineText: string, marker: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(lineText);
  return !!m && m[1]![0] === marker[0] && m[1]!.length >= marker.length;
}

/**
 * Whether a closer below already answers a fence opened with `marker`, reading
 * only as far as the FIRST fence-shaped line: that line is the whole answer,
 * and everything past it belongs to some other block.
 *
 * Scanning the whole rest of the note instead (any closer, anywhere) is what
 * stopped a fence typed ABOVE an existing block from closing: the block below
 * owns a closer, so the opener looked answered. It is not answered, it is
 * about to eat that block — CommonMark pairs the new opener with that closer
 * and everything between them, the other block's own fence line included,
 * becomes its content. That merge is exactly what this command exists to
 * prevent, so the line that decides has to be the first one, not any one.
 *
 * A line that opens but cannot close (it carries an info string, or the other
 * mark character) is another block beginning, so this fence still needs a
 * closer of its own. A bare fence line is both shapes at once and is read as
 * the closer, which is what CommonMark does with it too.
 */
export function pairedBelow(lines: string[], marker: string): boolean {
  for (const line of lines) {
    if (fenceCloser(line, marker)) return true;
    if (fenceOpener(line)) return false;
  }
  return false;
}

/**
 * The marker of the fence still open after reading `lines`, or null when they
 * end outside any fence. The walk both cases below share: a fence line toggles
 * state, everything else is content.
 */
function openMarkerAfter(lines: string[]): string | null {
  let open: string | null = null;
  for (const line of lines) {
    if (open) {
      if (fenceCloser(line, open)) open = null;
    } else {
      const f = fenceOpener(line);
      if (f) open = f.marker;
    }
  }
  return open;
}

// Enough of a doc head to hold a frontmatter block (the app-wide cap).
const HEAD_BYTES = 4096;

/**
 * The Enter binding. Handles exactly two shapes, falling through (false)
 * everywhere else so the ordinary newline machinery runs:
 * - caret at the end of a line-1 `---` that no closing fence answers yet;
 * - caret at the end of a code-fence opener no later line closes.
 * Both insert newline + blank line + the matching closer, caret on the blank.
 */
export const closeFence: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty) return false;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.to) return false;

  let closer: string | null = null;
  if (line.number === 1 && FM_FENCE.test(line.text)) {
    // Line 1's `---` opens frontmatter — unless a closing fence already
    // exists, in which case the block is real and Enter is just editing it.
    const head = state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length));
    if (frontmatterEnd(head) !== 0) return false;
    closer = "---";
  } else {
    const f = fenceOpener(line.text);
    if (!f) return false;
    // Lines above decide what this line IS: inside a still-open fence it is
    // content or the closer, not an opener. The walk starts after any
    // frontmatter block — its fences are params, not code, and a fence-shaped
    // line INSIDE the block is params too.
    const fmEnd = frontmatterEnd(state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length)));
    if (line.from < fmEnd) return false;
    const above = state.sliceDoc(fmEnd, line.from);
    if (line.from > fmEnd && openMarkerAfter(above.split("\n").slice(0, -1)) !== null) return false;
    // Lines below decide whether it needs closing: an opener a later closer
    // already answers is a real block, and Enter on it is an ordinary newline.
    const below = state.sliceDoc(Math.min(line.to + 1, state.doc.length), state.doc.length);
    if (below !== "" && pairedBelow(below.split("\n"), f.marker)) return false;
    closer = f.indent + f.marker;
  }

  dispatch(
    state.update({
      changes: { from: range.head, insert: `\n\n${closer}` },
      selection: { anchor: range.head + 1 },
      userEvent: "input",
    }),
  );
  return true;
};

/**
 * The caret line as it will read once `mark` lands at its end — indent, three
 * or more marks of one character, nothing else — or null when it will not be a
 * bare fence line. An info string cannot be there yet: the mark is going in at
 * the END of the line, so anything already following it would be in the way.
 */
function bareFence(before: string, mark: string): { indent: string; marker: string } | null {
  if (mark !== "`" && mark !== "~") return null;
  const m = /^( {0,3})([`~]{3,})$/.exec(before + mark);
  return m && m[2]![0] === mark ? { indent: m[1]!, marker: m[2]! } : null;
}

/**
 * The edit that answers `mark` completing a fence opener at the caret, or null
 * when the keystroke is ordinary typing. Two shapes:
 * - the third mark of a bare opener: plant its closer on the next line;
 * - a fourth or later mark on an opener whose closer is the line right below:
 *   grow that closer to match. CommonMark wants a closer at least as long as
 *   its opener, so without this the fourth mark would unterminate the block
 *   the third one just closed.
 * Both leave the caret on the opener, where the info string gets typed.
 *
 * A state function rather than a view one so the whole decision is testable
 * headlessly, the same way closeFence is.
 */
export function typedFence(state: EditorState, mark: string): TransactionSpec | null {
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty) return null;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.to) return null;
  const f = bareFence(line.text, mark);
  if (!f) return null;
  // Lines above decide what this line IS, exactly as in closeFence: inside a
  // still-open fence the mark being typed CLOSES that block rather than
  // opening one, and inside frontmatter it is params.
  const fmEnd = frontmatterEnd(state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length)));
  if (line.from < fmEnd) return null;
  const above = state.sliceDoc(fmEnd, line.from);
  if (line.from > fmEnd && openMarkerAfter(above.split("\n").slice(0, -1)) !== null) return null;

  if (f.marker.length > 3) {
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
    if (!next || next.text !== f.indent + f.marker.slice(1)) return null;
    return {
      changes: [
        { from: range.head, insert: mark },
        { from: next.to, insert: mark },
      ],
      selection: { anchor: range.head + mark.length },
      userEvent: "input.type",
    };
  }
  // Lines below decide whether it needs closing, same question as closeFence's.
  const below = state.sliceDoc(Math.min(line.to + 1, state.doc.length), state.doc.length);
  if (below !== "" && pairedBelow(below.split("\n"), f.marker)) return null;
  return {
    changes: { from: range.head, insert: `${mark}\n${f.indent}${f.marker}` },
    selection: { anchor: range.head + mark.length },
    userEvent: "input.type",
  };
}

// The typing half. An input handler and not a keymap entry: the mark has to be
// seen as text going in at a position, which is also what makes it inert for
// every other way characters arrive — a paste of a whole block, a programmatic
// insert, an agent's edit — none of which want a fence invented for them.
const typeFence = EditorView.inputHandler.of((view, from, to, text) => {
  const head = view.state.selection.main.head;
  if (from !== head || to !== head) return false;
  const spec = typedFence(view.state, text);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
});

export function fenceClose() {
  return [Prec.high(keymap.of([{ key: "Enter", run: closeFence }])), typeFence];
}
