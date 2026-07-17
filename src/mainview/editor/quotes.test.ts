import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { exitQuote, isQuoteMarkerOnly } from "./quotes";

// The command half, headless: EditorState + the markdown parser is all
// exitQuote reads, so the exact editor scenario is testable without a DOM.
function apply(doc: string, caret: number): { handled: boolean; doc: string; caret: number } {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret),
    extensions: [markdown({ base: markdownLanguage })],
  });
  const handled = exitQuote({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  return { handled, doc: state.doc.toString(), caret: state.selection.main.head };
}

describe("exitQuote", () => {
  test("Enter on the empty continuation line clears it — the one-press exit", () => {
    expect(apply("> 432\n> ", 8)).toEqual({ handled: true, doc: "> 432\n", caret: 6 });
  });

  test("a bare > line (no trailing space) exits too", () => {
    expect(apply("> 432\n>", 7)).toEqual({ handled: true, doc: "> 432\n", caret: 6 });
  });

  test("a quote line with content falls through to normal continuation", () => {
    expect(apply("> 432", 5).handled).toBe(false);
  });

  test("a marker-lookalike inside a code fence is code, not a quote", () => {
    const doc = "```\n> \n```";
    expect(apply(doc, 6).handled).toBe(false);
  });

  test("plain prose falls through untouched", () => {
    expect(apply("hello", 5).handled).toBe(false);
  });
});

describe("isQuoteMarkerOnly", () => {
  test("marker-only quote lines, spaced or bare, nested or indented", () => {
    for (const line of [">", "> ", " > ", "> > ", ">>", "  >\t"]) {
      expect(isQuoteMarkerOnly(line)).toBe(true);
    }
  });

  test("a quote line with content is not empty", () => {
    for (const line of ["> x", ">x", "> > words", "> -"]) {
      expect(isQuoteMarkerOnly(line)).toBe(false);
    }
  });

  test("lines without a marker are not quote lines at all", () => {
    for (const line of ["", "   ", "-", "- ", "text"]) {
      expect(isQuoteMarkerOnly(line)).toBe(false);
    }
  });

  test("a trailing CR (pasted CRLF text) does not defeat the match", () => {
    expect(isQuoteMarkerOnly("> \r")).toBe(true);
  });
});
