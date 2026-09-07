// Markdown formatting chords: ⌘B/⌘I toggle **strong**/*emphasis*, ⌘K wraps a
// [text](url) link. The decisions are pure TransactionSpec builders over
// EditorState (formatting.test.ts); the keymap below is the thin wrapper.
//
// Toggling reads the `*` run next to the content instead of matching a
// literal marker, so the two chords compose. Bold is on when both sides carry
// two or more stars, italic when both carry an odd count. ⌘I on **bold**
// yields ***bold***, and ⌘I again removes only the italic star. Emitted
// markers are always `*`, never `_`.
import { EditorSelection, Prec, type EditorState, type TransactionSpec } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";
import { keyOf } from "../commands/keys";

const WORD_CHAR = /[\p{L}\p{N}_]/u;

// The word around `pos` on its own line, or null when `pos` touches none.
// `*` is not a word character, so a caret inside **bo|ld** expands to the
// content and the runs outside it carry the toggle state.
function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  let from = pos;
  let to = pos;
  while (from > line.from && WORD_CHAR.test(state.sliceDoc(from - 1, from))) from -= 1;
  while (to < line.to && WORD_CHAR.test(state.sliceDoc(to, to + 1))) to += 1;
  return from === to ? null : { from, to };
}

function starsBefore(state: EditorState, pos: number): number {
  let n = 0;
  while (pos - n > 0 && state.sliceDoc(pos - n - 1, pos - n) === "*") n += 1;
  return n;
}

function starsAfter(state: EditorState, pos: number): number {
  let n = 0;
  while (pos + n < state.doc.length && state.sliceDoc(pos + n, pos + n + 1) === "*") n += 1;
  return n;
}

// changeByRange calls this callback once per selection range, and each call
// returns one spec, so multi-cursor works. An empty range expands to the word
// at the caret; the caret keeps its place in that word, shifting forward by
// the length of `marker` when wrapping and back by it when unwrapping. A
// caret with no word around it gets an empty marker pair to type into.
export function toggleInline(state: EditorState, marker: "**" | "*"): TransactionSpec {
  const len = marker.length;
  return state.changeByRange((range) => {
    let { from, to } = range;
    let caret: number | null = null;
    if (range.empty) {
      const word = wordAt(state, from);
      if (!word) {
        return {
          changes: { from, insert: marker + marker },
          range: EditorSelection.cursor(from + len),
        };
      }
      caret = from;
      ({ from, to } = word);
    }
    // A selection that grabbed the markers themselves toggles the same as one
    // on the content: the loops below trim the stars off both ends, so the
    // state comes from the runs outside the trimmed range.
    while (from < to && state.sliceDoc(from, from + 1) === "*") from += 1;
    while (to > from && state.sliceDoc(to - 1, to) === "*") to -= 1;
    const before = starsBefore(state, from);
    const after = starsAfter(state, to);
    const on =
      marker === "**" ? before >= 2 && after >= 2 : before % 2 === 1 && after % 2 === 1;
    if (on) {
      return {
        changes: [
          { from: from - len, to: from },
          { from: to, to: to + len },
        ],
        range:
          caret !== null
            ? EditorSelection.cursor(caret - len)
            : EditorSelection.range(from - len, to - len),
      };
    }
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range:
        caret !== null
          ? EditorSelection.cursor(caret + len)
          : EditorSelection.range(from + len, to + len),
    };
  });
}

// URL_RE matches a selection that is already a URL. insertLinkSpec makes such
// a selection the destination and puts the caret in the empty label. Any
// other selection becomes the label, with the caret in the empty destination.
const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;

export function insertLinkSpec(state: EditorState): TransactionSpec {
  return state.changeByRange((range) => {
    let { from, to } = range;
    if (range.empty) {
      const word = wordAt(state, from);
      if (word) ({ from, to } = word);
    }
    if (from === to) {
      return {
        changes: { from, insert: "[]()" },
        range: EditorSelection.cursor(from + 1),
      };
    }
    const text = state.sliceDoc(from, to);
    if (URL_RE.test(text)) {
      return {
        changes: { from, to, insert: `[](${text})` },
        range: EditorSelection.cursor(from + 1),
      };
    }
    return {
      changes: { from, to, insert: `[${text}]()` },
      range: EditorSelection.cursor(from + text.length + 3),
    };
  });
}

export const toggleBold: Command = (view) => {
  view.dispatch(toggleInline(view.state, "**"));
  return true;
};

export const toggleItalic: Command = (view) => {
  view.dispatch(toggleInline(view.state, "*"));
  return true;
};

export const insertLink: Command = (view) => {
  view.dispatch(insertLinkSpec(view.state));
  return true;
};

// Highest precedence, like the other app chords in setup.ts, so this keymap
// runs ahead of CodeMirror's own extensions. Each command returns true, which
// makes CodeMirror preventDefault the key. That stops WebKit's contenteditable
// ⌘B/⌘I, and it keeps the chord off AppKit's key-equivalent path, where an
// unhandled ⌘ key rings the alert.
export function formatting() {
  return Prec.highest(
    keymap.of([
      { key: keyOf("format.bold")!, run: toggleBold },
      { key: keyOf("format.italic")!, run: toggleItalic },
      { key: keyOf("format.link")!, run: insertLink },
    ]),
  );
}
