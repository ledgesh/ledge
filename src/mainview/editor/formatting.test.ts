import { describe, expect, test } from "bun:test";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { insertLinkSpec, toggleInline } from "./formatting";

// A state with one selection; head defaults to anchor (a caret).
function state(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({ doc, selection: { anchor, head } });
}

function apply(st: EditorState, spec: TransactionSpec) {
  const next = st.update(spec).state;
  const sel = next.selection.main;
  return { doc: next.doc.toString(), from: sel.from, to: sel.to };
}

function bold(st: EditorState) {
  return apply(st, toggleInline(st, "**"));
}

function italic(st: EditorState) {
  return apply(st, toggleInline(st, "*"));
}

function link(st: EditorState) {
  return apply(st, insertLinkSpec(st));
}

describe("bold / italic toggling", () => {
  test("a selection wraps and stays selected inside the markers", () => {
    expect(bold(state("hello world", 0, 5))).toEqual({ doc: "**hello** world", from: 2, to: 7 });
    expect(italic(state("hello world", 6, 11))).toEqual({ doc: "hello *world*", from: 7, to: 12 });
  });

  test("a selection already wrapped unwraps", () => {
    expect(bold(state("**hello** world", 2, 7))).toEqual({ doc: "hello world", from: 0, to: 5 });
    expect(italic(state("hello *world*", 7, 12))).toEqual({ doc: "hello world", from: 6, to: 11 });
  });

  test("a selection that grabbed the markers unwraps the same", () => {
    expect(bold(state("**hello**", 0, 9))).toEqual({ doc: "hello", from: 0, to: 5 });
    expect(italic(state("*hello*", 0, 7))).toEqual({ doc: "hello", from: 0, to: 5 });
  });

  test("a caret inside a word toggles the whole word and stays put", () => {
    expect(bold(state("hello world", 8))).toEqual({ doc: "hello **world**", from: 10, to: 10 });
    expect(bold(state("hello **world**", 10))).toEqual({ doc: "hello world", from: 8, to: 8 });
  });

  test("the two chords compose: italic on bold stacks, and peels only itself", () => {
    // ⌘I on **hello** adds the third star; ⌘I again removes only it.
    expect(italic(state("**hello**", 4))).toEqual({ doc: "***hello***", from: 5, to: 5 });
    expect(italic(state("***hello***", 5))).toEqual({ doc: "**hello**", from: 4, to: 4 });
    // ⌘B on ***hello*** peels the bold pair, leaving the italic star.
    expect(bold(state("***hello***", 5))).toEqual({ doc: "*hello*", from: 3, to: 3 });
    // ⌘B on *hello* stacks up to bold+italic.
    expect(bold(state("*hello*", 3))).toEqual({ doc: "***hello***", from: 5, to: 5 });
  });

  test("italic on bold content does not steal a bold star", () => {
    // The classic off-by-one: *un*-wrapping `**x**` by one star would silently
    // turn bold into italic. Parity keeps it additive instead.
    expect(italic(state("**hello**", 2, 7))).toEqual({ doc: "***hello***", from: 3, to: 8 });
  });

  test("a bare caret with no word drops an empty pair to type into", () => {
    expect(bold(state("a  b", 2))).toEqual({ doc: "a **** b", from: 4, to: 4 });
    expect(italic(state("", 0))).toEqual({ doc: "**", from: 1, to: 1 });
  });
});

describe("insert link", () => {
  test("a text selection becomes the label, caret in the empty destination", () => {
    expect(link(state("see docs now", 4, 8))).toEqual({ doc: "see [docs]() now", from: 11, to: 11 });
  });

  test("a URL selection becomes the destination, caret in the empty label", () => {
    expect(link(state("https://example.com", 0, 19))).toEqual({
      doc: "[](https://example.com)",
      from: 1,
      to: 1,
    });
  });

  test("a caret inside a word links the word", () => {
    expect(link(state("see docs", 6))).toEqual({ doc: "see [docs]()", from: 11, to: 11 });
  });

  test("a bare caret gets the empty skeleton, caret in the label", () => {
    expect(link(state("", 0))).toEqual({ doc: "[]()", from: 1, to: 1 });
  });
});
