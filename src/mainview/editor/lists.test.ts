import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import {
  continueListBody,
  continueListItem,
  continueMarkup,
  exitListContinuation,
  isIndentOnly,
  listContentIndent,
} from "./lists";

// The command half, headless: EditorState + the markdown parser is all these
// read, so the exact editor scenario is testable without a DOM (quotes.test.ts).
function run(cmd: (t: any) => boolean, doc: string, caret: number) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret),
    extensions: [markdown({ base: markdownLanguage })],
  });
  const handled = cmd({
    state,
    dispatch: (tr: any) => {
      state = tr.state;
    },
  });
  return { handled, doc: state.doc.toString(), caret: state.selection.main.head, state };
}

// Shift+Enter as the editor actually resolves it: our binding first (Prec.high),
// CodeMirror's default soft newline when it declines.
function shiftEnter(doc: string, caret: number) {
  const ours = run(continueListItem, doc, caret);
  return ours.handled ? ours : run(insertNewlineAndIndent, doc, caret);
}

// Enter as the editor actually resolves it: ours, then markdown's markup
// continuation, then the default newline. quoteExit/closeFence sit in the same
// band but never match the shapes below.
function enter(doc: string, caret: number) {
  // The editor's Enter band, in registration order (setup.ts). quoteExit and
  // closeFence sit in it too, but never match the shapes below.
  const chain = [exitListContinuation, continueListBody, continueMarkup, insertNewlineAndIndent];
  for (const cmd of chain) {
    const r = run(cmd, doc, caret);
    if (r.handled) return r;
  }
  throw new Error("no Enter command handled");
}

describe("continueListItem", () => {
  test("a bullet's continuation lands under the text, not the dash", () => {
    expect(shiftEnter("- foo", 5)).toMatchObject({ handled: true, doc: "- foo\n  ", caret: 8 });
  });

  test("a task item indents to its bullet, not past the checkbox", () => {
    expect(shiftEnter("- [ ] foo", 9)).toMatchObject({ doc: "- [ ] foo\n  ", caret: 12 });
    expect(shiftEnter("- [x] foo", 9)).toMatchObject({ doc: "- [x] foo\n  ", caret: 12 });
  });

  test("an ordered item indents past its number, however wide", () => {
    expect(shiftEnter("1. foo", 6)).toMatchObject({ doc: "1. foo\n   ", caret: 10 });
    expect(shiftEnter("10) foo", 7)).toMatchObject({ doc: "10) foo\n    ", caret: 12 });
  });

  test("a nested item carries its own indent", () => {
    expect(shiftEnter("- foo\n  - bar", 13)).toMatchObject({ doc: "- foo\n  - bar\n    ", caret: 18 });
  });

  test("the caret already on a continuation line reuses the ITEM's indent", () => {
    expect(shiftEnter("- foo\n  bar", 11)).toMatchObject({ doc: "- foo\n  bar\n  ", caret: 14 });
  });

  test("mid-line, the text after the caret moves down indented", () => {
    expect(shiftEnter("- foo bar", 5)).toMatchObject({ doc: "- foo\n   bar", caret: 8 });
  });

  test("outside a list it falls through to the plain soft newline", () => {
    expect(run(continueListItem, "hello", 5).handled).toBe(false);
    expect(run(continueListItem, "> quoted", 8).handled).toBe(false);
    expect(run(continueListItem, "# heading", 9).handled).toBe(false);
  });

  test("a marker-lookalike inside a code fence is code, not a list", () => {
    expect(run(continueListItem, "```\n- foo\n```", 9).handled).toBe(false);
  });

  test("a fenced block INSIDE an item is still code", () => {
    expect(run(continueListItem, "- foo\n  ```\n  x\n  ```", 15).handled).toBe(false);
  });

  test("a non-empty selection falls through", () => {
    let state = EditorState.create({
      doc: "- foo",
      selection: EditorSelection.range(2, 5),
      extensions: [markdown({ base: markdownLanguage })],
    });
    expect(continueListItem({ state, dispatch: () => {} })).toBe(false);
  });
});

describe("continueListBody", () => {
  test("Enter on a continuation line adds another at the same indent", () => {
    expect(run(continueListBody, "- foo\n  bar", 11)).toMatchObject({
      handled: true,
      doc: "- foo\n  bar\n  ",
      caret: 14,
    });
  });

  test("a task item's text survives it — upstream's Enter deletes the item here", () => {
    expect(enter("- [ ] foo\n  bar", 15)).toMatchObject({ doc: "- [ ] foo\n  bar\n  ", caret: 18 });
    expect(run(insertNewlineContinueMarkup, "- [ ] foo\n  bar", 15).doc).toBe("- [ ] foo\n");
  });

  test("the item's FIRST line stays upstream's — that Enter means next item", () => {
    expect(run(continueListBody, "- foo", 5).handled).toBe(false);
    expect(run(continueListBody, "- foo\n  - bar", 13).handled).toBe(false);
    expect(enter("- foo", 5)).toMatchObject({ doc: "- foo\n- " });
    expect(enter("- [ ] foo", 9)).toMatchObject({ doc: "- [ ] foo\n- [ ] " });
  });

  test("a block with its own line grammar inside an item keeps it", () => {
    // A quote nested in an item: upstream's Enter owes it another `> `.
    expect(run(continueListBody, "- foo\n  > quoted", 16).handled).toBe(false);
    expect(run(continueListBody, "- foo\n  ```\n  x\n  ```", 15).handled).toBe(false);
  });

  test("outside a list it falls through", () => {
    expect(run(continueListBody, "hello\nworld", 11).handled).toBe(false);
  });
});

describe("exitListContinuation", () => {
  test("Enter on the abandoned continuation clears it — the one-press exit", () => {
    expect(enter("- foo\n  ", 8)).toMatchObject({ doc: "- foo\n", caret: 6 });
    expect(enter("- [ ] foo\n  ", 12)).toMatchObject({ doc: "- [ ] foo\n", caret: 10 });
  });

  test("a marker-only line stays upstream's empty-item case", () => {
    expect(run(exitListContinuation, "- foo\n- ", 8).handled).toBe(false);
  });

  test("an indent-only line under prose is not a list continuation", () => {
    expect(run(exitListContinuation, "hello\n  ", 8).handled).toBe(false);
  });

  test("line 1 has nothing above it to be a continuation of", () => {
    expect(run(exitListContinuation, "  ", 2).handled).toBe(false);
  });
});

// The reported bug, end to end: Shift+Enter then typing then Enter used to
// leave the list — and on an ordered item, delete the typed line outright.
describe("Shift+Enter then Enter", () => {
  test("the continuation survives the next Enter, ordered items included", () => {
    for (const [item, indent] of [
      ["- foo", "  "],
      ["1. foo", "   "],
      ["- [ ] foo", "  "],
    ] as const) {
      const soft = shiftEnter(item, item.length);
      const typed = `${soft.doc}bar`;
      const next = enter(typed, typed.length);
      expect(next.doc).toBe(`${item}\n${indent}bar\n${indent}`);
    }
  });

  test("Shift+Enter then Enter straight away leaves no stray whitespace", () => {
    const soft = shiftEnter("- foo", 5);
    expect(enter(soft.doc, soft.caret)).toMatchObject({ doc: "- foo\n", caret: 6 });
  });
});

describe("continueMarkup", () => {
  test("Enter on an empty marker exits the list, two-item list included", () => {
    // The reported shape: a fresh two-item list, which is what the end of a
    // note gives you. Upstream promotes it to a loose list instead, and the
    // blank line reads as a stray double newline.
    expect(enter("- Line 1\n- ", 11)).toMatchObject({ doc: "- Line 1\n", caret: 9 });
    expect(run(insertNewlineContinueMarkup, "- Line 1\n- ", 11).doc).toBe("- Line 1\n\n- ");

    // One more item above and upstream already agreed — still does.
    expect(enter("- a\n- b\n- ", 10)).toMatchObject({ doc: "- a\n- b\n", caret: 8 });
    expect(enter("- [ ] a\n- [ ] ", 14)).toMatchObject({ doc: "- [ ] a\n", caret: 8 });
  });

  test("a loose list does not spread its blank lines into the next item", () => {
    // The reported shape: a blank line below an earlier item makes ONE loose
    // list, and upstream then prefixes every new item with a blank of its own.
    expect(enter("- [ ] Security\n\n- test", 22)).toMatchObject({
      doc: "- [ ] Security\n\n- test\n- ",
      caret: 25,
    });
    expect(run(insertNewlineContinueMarkup, "- [ ] Security\n\n- test", 22).doc).toBe(
      "- [ ] Security\n\n- test\n\n- ",
    );
  });

  test("trimming the blank keeps everything else upstream computed", () => {
    // Ordered lists still renumber...
    expect(enter("1. a\n2. b", 9)).toMatchObject({ doc: "1. a\n2. b\n3. " });
    expect(enter("1. a\n\n2. b", 10)).toMatchObject({ doc: "1. a\n\n2. b\n3. ", caret: 14 });
    // ...a quoted list keeps its `>`...
    expect(enter("> - a\n>\n> - b", 13)).toMatchObject({ doc: "> - a\n>\n> - b\n> - ", caret: 18 });
    // ...and a nested one keeps its indent.
    expect(enter("- a\n  - x\n\n  - y", 16)).toMatchObject({
      doc: "- a\n  - x\n\n  - y\n  - ",
      caret: 21,
    });
  });

  test("an empty nested item falls back one level, not out of the list", () => {
    expect(enter("- a\n  - b\n  - ", 14)).toMatchObject({ doc: "- a\n  - b\n- ", caret: 12 });
  });
});

describe("listContentIndent", () => {
  test("the marker run becomes blanks of the same width", () => {
    expect(listContentIndent("- foo")).toBe("  ");
    expect(listContentIndent("* foo")).toBe("  ");
    expect(listContentIndent("+ foo")).toBe("  ");
    expect(listContentIndent("  - foo")).toBe("    ");
    expect(listContentIndent("1. foo")).toBe("   ");
    expect(listContentIndent("123) foo")).toBe("     ");
  });

  test("a checkbox is item content, so it does not widen the indent", () => {
    expect(listContentIndent("- [ ] foo")).toBe("  ");
    expect(listContentIndent("- [X] foo")).toBe("  ");
    expect(listContentIndent("1. [ ] foo")).toBe("   ");
  });

  test("a tab-indented item keeps its tabs as tabs", () => {
    expect(listContentIndent("\t- foo")).toBe("\t  ");
  });

  test("an empty item still has a content column", () => {
    expect(listContentIndent("- ")).toBe("  ");
  });

  test("a quoted item keeps its markers and blanks only the bullet", () => {
    expect(listContentIndent("> - foo")).toBe(">   ");
    expect(listContentIndent("> > 1. foo")).toBe("> >    ");
  });

  test("lines that open no item", () => {
    for (const line of ["", "foo", "-foo", "-", "1.foo", "#- foo", "> foo"]) {
      expect(listContentIndent(line)).toBe(null);
    }
  });
});

describe("isIndentOnly", () => {
  test("whitespace and nothing else", () => {
    for (const line of [" ", "  ", "\t", " \t "]) expect(isIndentOnly(line)).toBe(true);
  });

  test("an empty line is already the exit, not a continuation", () => {
    expect(isIndentOnly("")).toBe(false);
  });

  test("any content disqualifies it", () => {
    for (const line of ["  x", "- ", ">"]) expect(isIndentOnly(line)).toBe(false);
  });

  test("a trailing CR (pasted CRLF text) does not defeat the match", () => {
    expect(isIndentOnly("  \r")).toBe(true);
  });
});
