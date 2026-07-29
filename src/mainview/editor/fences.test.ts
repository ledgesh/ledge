import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { closeFence, fenceCloser, fenceOpener, pairedBelow, typedFence } from "./fences";

// The command half, headless (quotes.test.ts's harness): the pairing scan is
// pure text, so no parser is even needed in the extensions.
function apply(doc: string, caret: number): { handled: boolean; doc: string; caret: number } {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) });
  const handled = closeFence({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  return { handled, doc: state.doc.toString(), caret: state.selection.main.head };
}

// The typing half: `mark` arriving at `caret`, and what the document becomes.
function type(
  doc: string,
  caret: number,
  mark = "`",
): { handled: boolean; doc: string; caret: number } {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) });
  const spec = typedFence(state, mark);
  if (!spec) return { handled: false, doc, caret };
  const next = state.update(spec).state;
  return { handled: true, doc: next.doc.toString(), caret: next.selection.main.head };
}

describe("closeFence: frontmatter", () => {
  test("Enter after a lone line-1 --- closes the block, caret between", () => {
    expect(apply("---", 3)).toEqual({ handled: true, doc: "---\n\n---", caret: 4 });
  });

  test("existing content slides below the new block", () => {
    expect(apply("---\n# Title", 3)).toEqual({ handled: true, doc: "---\n\n---\n# Title", caret: 4 });
  });

  test("an already-closed block gets an ordinary newline", () => {
    expect(apply("---\ncwd: /x\n---", 3).handled).toBe(false);
  });

  test("--- below line 1 is an hr (or setext), never frontmatter", () => {
    expect(apply("text\n---", 8).handled).toBe(false);
  });

  test("a caret mid-fence falls through — only the line-end Enter completes", () => {
    expect(apply("---", 2).handled).toBe(false);
  });
});

describe("closeFence: code fences", () => {
  test("Enter after an unterminated opener closes it, info string and all", () => {
    expect(apply("```js", 5)).toEqual({ handled: true, doc: "```js\n\n```", caret: 6 });
  });

  test("tilde fences close with tildes", () => {
    expect(apply("~~~", 3)).toEqual({ handled: true, doc: "~~~\n\n~~~", caret: 4 });
  });

  test("an indented opener closes at its own indent", () => {
    expect(apply("  ```sh\ntext", 7)).toEqual({
      handled: true,
      doc: "  ```sh\n\n  ```\ntext",
      caret: 8,
    });
  });

  test("a longer opener needs an equally long closer", () => {
    expect(apply("````\nx\n```", 4)).toEqual({
      handled: true,
      doc: "````\n\n````\nx\n```",
      caret: 5,
    });
  });

  test("a later closer already answers the opener", () => {
    expect(apply("```js\ncode\n```", 5).handled).toBe(false);
  });

  test("the closing fence of an open block is a closer, not an opener", () => {
    expect(apply("```js\ncode\n```", 14).handled).toBe(false);
  });

  test("a fence-shaped line inside frontmatter is params, not code", () => {
    expect(apply("---\n```\n---\nx", 7).handled).toBe(false);
  });

  test("a fence right after the frontmatter block still closes", () => {
    expect(apply("---\na: b\n---\n```py", 18)).toEqual({
      handled: true,
      doc: "---\na: b\n---\n```py\n\n```",
      caret: 19,
    });
  });

  test("a backtick in a backtick info string disqualifies the opener", () => {
    expect(apply("```a`b", 6).handled).toBe(false);
  });

  // The block below owns a closer, but that closer is not this opener's: left
  // unclosed, CommonMark pairs the two and swallows the block between them.
  test("an opener typed above an existing block still closes", () => {
    expect(apply("```\n\n```sh\npwd\n```", 3)).toEqual({
      handled: true,
      doc: "```\n\n```\n\n```sh\npwd\n```",
      caret: 4,
    });
  });

  test("a block further down the note does not answer the opener either", () => {
    expect(apply("```py\n\n# notes\n\n```sh\npwd\n```", 5).handled).toBe(true);
  });

  test("the opener of a closed block is still left alone", () => {
    expect(apply("```sh\npwd\n```\n\n```sh\nls\n```", 5).handled).toBe(false);
  });
});

describe("typedFence", () => {
  test("the third mark plants the closer and leaves the caret on the opener", () => {
    expect(type("``", 2)).toEqual({ handled: true, doc: "```\n```", caret: 3 });
    expect(type("~~", 2, "~")).toEqual({ handled: true, doc: "~~~\n~~~", caret: 3 });
  });

  test("an indented opener plants an equally indented closer", () => {
    expect(type("  ``", 4)).toEqual({ handled: true, doc: "  ```\n  ```", caret: 5 });
  });

  // The bug this half exists for: the closer belonging to the block below
  // pairs with the opener being typed, and until something answers it the note
  // reads as one block from here to there.
  test("a fence typed above an existing block gets its own closer at once", () => {
    expect(type("``\n\n```sh\necho 123\n```", 2)).toEqual({
      handled: true,
      doc: "```\n```\n\n```sh\necho 123\n```",
      caret: 3,
    });
  });

  test("a closer below already answers this opener", () => {
    expect(type("``\ncode\n```", 2).handled).toBe(false);
  });

  test("inside an open block the mark closes it, so nothing is planted", () => {
    expect(type("```sh\nls\n``", 11).handled).toBe(false);
  });

  test("a fence-shaped line inside frontmatter is params, not code", () => {
    expect(type("---\n``\n---\nx", 6).handled).toBe(false);
  });

  test("only a mark completing the whole line counts", () => {
    expect(type("``", 1).handled).toBe(false); // caret mid-line
    expect(type("see ``", 6).handled).toBe(false); // an inline code span
    expect(type("~~", 2).handled).toBe(false); // marks must match
    expect(type("``", 2, "x").handled).toBe(false);
  });

  // A closer shorter than its opener does not close it, so the pair grows
  // together — otherwise the fourth backtick of a ````-fence would silently
  // unterminate the block the third one just closed.
  test("a fourth mark grows the closer it planted", () => {
    expect(type("```\n```", 3)).toEqual({ handled: true, doc: "````\n````", caret: 4 });
  });

  test("a fourth mark with no planted closer below is left alone", () => {
    expect(type("```\ncode\n```", 3).handled).toBe(false);
  });
});

describe("pairedBelow", () => {
  test("the first fence-shaped line decides", () => {
    expect(pairedBelow(["code", "```"], "```")).toBe(true);
    expect(pairedBelow(["```sh", "pwd", "```"], "```")).toBe(false);
  });

  test("a fence that cannot close this one is another block starting", () => {
    expect(pairedBelow(["~~~", "~~~"], "```")).toBe(false);
    expect(pairedBelow(["```", "```"], "````")).toBe(false);
  });

  test("nothing fence-shaped below leaves the opener unanswered", () => {
    expect(pairedBelow([], "```")).toBe(false);
    expect(pairedBelow(["just", "prose"], "```")).toBe(false);
  });

  // A bare fence line is an opener and a closer at once; CommonMark reads it as
  // the closer, and so does this.
  test("a bare fence below is read as the closer", () => {
    expect(pairedBelow(["", "```", "pwd", "```"], "```")).toBe(true);
  });
});

describe("fenceOpener / fenceCloser", () => {
  test("openers: marks, info strings, up to 3 spaces of indent", () => {
    expect(fenceOpener("```")).toEqual({ indent: "", marker: "```" });
    expect(fenceOpener("   ````python")).toEqual({ indent: "   ", marker: "````" });
    expect(fenceOpener("~~~ any ` info")).toEqual({ indent: "", marker: "~~~" });
    expect(fenceOpener("    ```")).toBeNull(); // 4 spaces: indented code
    expect(fenceOpener("``")).toBeNull();
    expect(fenceOpener("text")).toBeNull();
  });

  test("closers: same character, at least as many, nothing after", () => {
    expect(fenceCloser("```", "```")).toBe(true);
    expect(fenceCloser("````", "```")).toBe(true);
    expect(fenceCloser("```", "````")).toBe(false);
    expect(fenceCloser("~~~", "```")).toBe(false);
    expect(fenceCloser("``` js", "```")).toBe(false);
    expect(fenceCloser("  ``` \r", "```")).toBe(true);
  });
});
