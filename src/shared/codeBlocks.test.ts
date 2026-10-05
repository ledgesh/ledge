import { describe, expect, test } from "bun:test";
import { codeBlocksOf } from "./codeBlocks";

const summary = (text: string) =>
  codeBlocksOf(text).map((b) => ({ line: b.line, lang: b.lang, code: b.code, closed: b.closed }));

describe("codeBlocksOf", () => {
  test("finds each block with its opener line, language and body", () => {
    const text = ["# Deploy", "", "```sh", "echo one", "echo two", "```", "", "~~~python", "print(1)", "~~~"].join("\n");
    expect(summary(text)).toEqual([
      { line: 3, lang: "sh", code: "echo one\necho two", closed: true },
      { line: 8, lang: "python", code: "print(1)", closed: true },
    ]);
  });

  test("keeps the fence's attributes", () => {
    const [b] = codeBlocksOf('```sh name=migrate confirm="Sure?"\nls\n```\n');
    expect(Object.fromEntries(b!.attrs)).toEqual({ name: "migrate", confirm: "Sure?" });
  });

  test("an unclosed block runs to the end and says so", () => {
    expect(summary("text\n```sh\nrm -rf x\nmore")).toEqual([{ line: 2, lang: "sh", code: "rm -rf x\nmore", closed: false }]);
    expect(summary("```sh")).toEqual([{ line: 1, lang: "sh", code: "", closed: false }]);
  });

  test("a longer fence holds a shorter one as body", () => {
    expect(summary("````markdown\n```sh\nls\n```\n````")).toEqual([
      { line: 1, lang: "markdown", code: "```sh\nls\n```", closed: true },
    ]);
  });

  test("a heading-shaped line inside a block is body, not a heading", () => {
    expect(summary("```sh\n# comment\n```")).toEqual([{ line: 1, lang: "sh", code: "# comment", closed: true }]);
  });

  test("CRLF text reads like LF text", () => {
    expect(summary("```sh\r\necho hi\r\n```\r\n")).toEqual([{ line: 1, lang: "sh", code: "echo hi", closed: true }]);
  });

  test("a block in a blockquote has no language and is never closed, as in the editor", () => {
    // Both read the opener off the whole line, "> " included, which neither
    // fenceOpener nor parseFenceInfo accepts, so the editor draws no run pair
    // on it either (editor/blocks.ts fenceClosed).
    const [b] = codeBlocksOf("> ```sh\n> ls\n> ```");
    expect(b!.lang).toBeNull();
    expect(b!.closed).toBe(false);
  });

  test("a note with no blocks has none", () => {
    expect(codeBlocksOf("# Title\n\nJust prose with `inline` code.")).toEqual([]);
  });
});
