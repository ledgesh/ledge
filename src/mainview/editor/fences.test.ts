import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  closeFence,
  fenceCloser,
  fenceOpener,
  insertCodeBlockSpec,
  pairedBelow,
  typedFence,
} from "./fences";

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

// The verb behind the same block: what a client with no backtick key asks for
// (format.codeBlock). `|` marks a caret and a `[...]` pair a selection, so the
// case being tested reads as the document it is about.
function place(doc: string): { text: string; anchor: number; head: number } {
  const bar = doc.indexOf("|");
  if (bar !== -1) return { text: doc.replace("|", ""), anchor: bar, head: bar };
  const open = doc.indexOf("[");
  const close = doc.indexOf("]") - 1;
  return { text: doc.replace("[", "").replace("]", ""), anchor: open, head: close };
}

// The document after the command, with `|` back where the caret is (or the
// selection's own brackets, which is how the wrap's answer is read).
function block(doc: string): string | null {
  const { text, anchor, head } = place(doc);
  const state = EditorState.create({ doc: text, selection: EditorSelection.range(anchor, head) });
  const spec = insertCodeBlockSpec(state);
  if (!spec) return null;
  const next = state.update(spec).state;
  const out = next.doc.toString();
  const sel = next.selection.main;
  if (sel.empty) return `${out.slice(0, sel.head)}|${out.slice(sel.head)}`;
  return `${out.slice(0, sel.from)}[${out.slice(sel.from, sel.to)}]${out.slice(sel.to)}`;
}

describe("insertCodeBlockSpec", () => {
  test("an empty line becomes the block, caret in the body", () => {
    expect(block("|")).toBe("```sh\n|\n```");
    expect(block("# Title\n\n|\n")).toBe("# Title\n\n```sh\n|\n```\n");
  });

  test("a line with text keeps it, and the block goes below a blank line", () => {
    expect(block("run this|")).toBe("run this\n\n```sh\n|\n```");
  });

  // The caret is where it is, not where the line ends: a block belongs after
  // the sentence being written, never inside it.
  test("a caret mid-line still gets a whole block after the line", () => {
    expect(block("run| this")).toBe("run this\n\n```sh\n|\n```");
  });

  test("a selection is wrapped whole, and the language is what is selected", () => {
    expect(block("[echo hi]")).toBe("```[sh]\necho hi\n```");
    expect(block("[ls\npwd]")).toBe("```[sh]\nls\npwd\n```");
  });

  test("a selection grows to whole lines before it is wrapped", () => {
    expect(block("ec[ho h]i")).toBe("```[sh]\necho hi\n```");
  });

  // A triple-click's selection ends at the START of the line below, which is
  // the line the eye never highlighted — and, next to a block, is its fence.
  test("a selection ending at the next line's start stops on the line above", () => {
    expect(block("[echo hi\n]")).toBe("```[sh]\necho hi\n```\n");
    expect(block("[echo hi\n]```sh\nls\n```")).toBe("```[sh]\necho hi\n```\n```sh\nls\n```");
  });

  test("nothing happens inside a block, on its fences, or in the frontmatter", () => {
    expect(block("```sh\nl|s\n```")).toBeNull();
    expect(block("``|`sh\nls\n```")).toBeNull();
    expect(block("```sh\nls\n``|`")).toBeNull();
    expect(block("---\ncwd: |/tmp\n---\n# T")).toBeNull();
  });

  test("the line after a closed block is ordinary ground again", () => {
    expect(block("```sh\nls\n```\n|")).toBe("```sh\nls\n```\n```sh\n|\n```");
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
