import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { closeFence, fenceCloser, fenceOpener } from "./fences";

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
