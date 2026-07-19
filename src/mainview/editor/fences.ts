// Enter on an unterminated fence opener closes the fence.
//
// Typing `---` on line 1 (frontmatter) or ```lang anywhere (code) has an ugly
// in-between moment: until the closing fence exists, the parser reads the
// rest of the note as the fence's inside — everything below the caret dims or
// restyles as code mid-gesture. Bracket-autoclose semantics fix it: the Enter
// that ends the opener line inserts the closing fence too and leaves the
// caret on the empty line between, so the document never lurches. Only the
// unterminated case: Enter on the opener of an already-closed block is an
// ordinary newline, never a stray extra fence.
//
// Fence pairing here is the text scan, not the syntax tree: the decision runs
// between two fast keystrokes (quotes.ts's timing problem), and what it needs
// — is some earlier fence still open, does any later line close this one — is
// a line walk both ends of the app already agree on, not a parse.
import { Prec, type StateCommand } from "@codemirror/state";
import { keymap } from "@codemirror/view";
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
    // Lines below decide whether it needs closing: a later closer will pair
    // with this opener on its own.
    const below = state.sliceDoc(Math.min(line.to + 1, state.doc.length), state.doc.length);
    if (below !== "" && below.split("\n").some((l) => fenceCloser(l, f.marker))) return false;
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

export function fenceClose() {
  return Prec.high(keymap.of([{ key: "Enter", run: closeFence }]));
}
