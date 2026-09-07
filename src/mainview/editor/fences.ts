// An unterminated fence closes itself: on the mark that completes the opener,
// and on Enter. The grammar of both halves is interactions.md §3, the "Fence
// auto-close" row.
//
// The openers are `---` on line 1 (frontmatter) and ```lang anywhere (code).
// Until a closing fence exists, the parser reads the rest of the note as the
// fence's inside. Text below the caret restyles as code, and a block already
// sitting below is swallowed (see `pairedBelow`).
//
// Typing gets bracket-autoclose semantics. The third backtick or tilde plants
// the matching closer on the next line, so the note is never left
// unterminated. Enter is the other half, for the openers typing never sees: a
// pasted opener, an opener whose closer was deleted, and line 1's `---`. In
// those the unterminated state already exists, and Enter repairs it. Line 1's
// `---` waits for Enter because three dashes are a thematic break or a Setext
// rule everywhere else, so only the Enter that commits the line can read them
// as frontmatter. Both halves act only on an opener no closer answers.
//
// Fence pairing here is a text scan, not the syntax tree. The decision runs
// between two fast keystrokes (quotes.ts's timing problem). Both questions it
// asks (is some earlier fence still open, does any later line close this one)
// are a line walk both ends of the app already agree on.
import {
  Prec,
  type EditorState,
  type StateCommand,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import { frontmatterEnd } from "../../shared/frontmatter";

// The frontmatter opener, shared/frontmatter.ts's FENCE: exactly three
// dashes, trailing blanks (and a pasted \r) tolerated.
const FM_FENCE = /^---[ \t\r]*$/;

// A code-fence opener per CommonMark: up to 3 spaces of indent, then ``` or
// ~~~ (3+ marks), then an info string. A backtick fence's info string may not
// contain a backtick (` ```js`` ` is not a fence).
const OPEN_TICK = /^( {0,3})(`{3,})([^`]*)$/;
const OPEN_TILDE = /^( {0,3})(~{3,})(.*)$/;

/**
 * The line's code-fence opener shape (its indent and its fence marks), or
 * null. Pure, so the grammar is testable line by line.
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
 * only as far as the first fence-shaped line. That line is the whole answer,
 * and everything past it belongs to some other block.
 *
 * Scanning the whole rest of the note instead (any closer, anywhere) is what
 * stopped a fence typed above an existing block from closing: that block owns
 * a closer, so the new opener looked answered. What happened instead was a
 * merge. CommonMark pairs the new opener with that closer, and everything
 * between them, the other block's own fence line included, becomes its
 * content. Preventing that merge is why the line that decides is the first
 * one, not any one.
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
 * end outside any fence. A fence line toggles the state, everything else is
 * content.
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
    // Line 1's `---` opens frontmatter, unless a closing fence already exists.
    // Then the block is real and Enter is ordinary editing.
    const head = state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length));
    if (frontmatterEnd(head) !== 0) return false;
    closer = "---";
  } else {
    const f = fenceOpener(line.text);
    if (!f) return false;
    // Lines above decide what this line is: inside a still-open fence it is
    // content or the closer, not an opener. The walk starts after any
    // frontmatter block, whose fences are params rather than code. A
    // fence-shaped line inside that block is params too.
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
 * The caret line as it will read once `mark` lands at its end (indent, then
 * three or more marks of one character, nothing else), or null when it will
 * not be a bare fence line. An info string cannot be there yet: the mark goes
 * in at the end of the line, so any text already on the line would fall
 * between the fence marks and the mark being typed.
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
  // Lines above decide what this line is, exactly as in closeFence. Inside a
  // still-open fence the mark being typed closes that block rather than
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

// --- inserting a block as a command ------------------------------------------
//
// Everything above answers a fence being typed, which is the desktop's way in.
// It is no way at all on a phone: the backtick is not on the iPhone keyboard's
// letter page, so the three marks that open a block are three trips through
// the numeric page with a long press each (ios.md §7). `format.codeBlock`
// exposes the same act as a command, so the accessory bar can name it and the
// palette can offer it (interactions.md §1a).
//
// The command writes a language rather than a bare fence, because a bare fence
// cannot run. The ▶ comes from the info string's first word being in
// `blocks.runnable` (editor/blocks.ts isRunnable), so an empty info string
// would give a phone a block it could not use and no hint about why.

/**
 * The language a new block gets.
 *
 * `sh` because this is the notebook that runs commands. It also makes the new
 * block runnable straight away, and a block inserted on a phone is nearly
 * always a command someone is about to press ▶ on. Writing the block by hand
 * costs three backticks and a language word: the backticks are the expensive
 * part on a phone, so the command types them, and changing `sh` afterwards
 * costs a few letters on the keyboard's letter page.
 */
export const NEW_BLOCK_LANG = "sh";

/**
 * Whether `pos` sits somewhere a fence must not be planted: inside a
 * frontmatter block (its fences are params, not code), on a fence line itself,
 * or inside a block some earlier fence opened.
 *
 * The same walk `typedFence` does above, asked as a question rather than as a
 * bail-out, and for the same reason. A second fence inside the first does not
 * nest: it ends that block early, and the lines after it, the outer block's
 * own closer included, land as stray prose or as a new opener.
 */
function withinCode(state: EditorState, pos: number): boolean {
  const fmEnd = frontmatterEnd(state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length)));
  const line = state.doc.lineAt(pos);
  if (line.from < fmEnd) return true;
  if (fenceOpener(line.text)) return true;
  if (line.from === fmEnd) return false;
  return openMarkerAfter(state.sliceDoc(fmEnd, line.from).split("\n").slice(0, -1)) !== null;
}

/**
 * The edit that puts a fenced block at the selection, or null where one cannot
 * go (see `withinCode`). Null is a silent no-op, the same answer Open Link and
 * Toggle Checkbox give a caret that is not on one.
 *
 * Two shapes, and the caret lands in each on the thing still missing:
 * - a bare caret gets an empty block and sits in its body, because the
 *   language is already written and the code is not;
 * - a selection is wrapped whole and the language is selected, because the
 *   code is already written and `sh` is a guess about it. Typing replaces the
 *   guess, and typing nothing accepts it.
 *
 * A caret on a line with text puts the block after a blank line rather than
 * against the prose. CommonMark reads it the same either way (a fence may
 * interrupt a paragraph). The blank line is for the person reading the note.
 */
export function insertCodeBlockSpec(state: EditorState): TransactionSpec | null {
  const range = state.selection.main;
  // A selection ending exactly at a line's start stops on the line above it,
  // where the selection looks like it ends. Taking `lineAt(to)` whole would
  // wrap a line nobody highlighted, and where the selection stops against an
  // existing block, that line is the block's opening fence.
  const end = !range.empty && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
  if (withinCode(state, range.from) || withinCode(state, end)) return null;
  const opener = `\`\`\`${NEW_BLOCK_LANG}`;

  if (!range.empty) {
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(end);
    const body = state.sliceDoc(first.from, last.to);
    return {
      changes: { from: first.from, to: last.to, insert: `${opener}\n${body}\n\`\`\`` },
      selection: { anchor: first.from + 3, head: first.from + opener.length },
      userEvent: "input",
    };
  }

  const line = state.doc.lineAt(range.head);
  if (line.text.trim() === "") {
    return {
      changes: { from: line.from, to: line.to, insert: `${opener}\n\n\`\`\`` },
      selection: { anchor: line.from + opener.length + 1 },
      userEvent: "input",
    };
  }
  return {
    changes: { from: line.to, insert: `\n\n${opener}\n\n\`\`\`` },
    selection: { anchor: line.to + opener.length + 3 },
    userEvent: "input",
  };
}

/** The command behind `format.codeBlock` (commands/glue.ts). */
export const insertCodeBlock: Command = (view) => {
  const spec = insertCodeBlockSpec(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
};

// The typing half. An input handler rather than a keymap entry, so the mark is
// seen as text going in at a position. That also leaves it inert for every
// other way characters arrive (a paste of a whole block, a programmatic
// insert, an agent's edit), none of which want a fence invented for them.
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
