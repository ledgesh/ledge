// What spell checking skips, run against @lezer/markdown directly (the
// livePreview.test.ts arrangement). Assertions read the skipped text back out
// of the source, so they do not depend on how the parser slices nodes.
import { describe, expect, test } from "bun:test";
import { GFM, parser } from "@lezer/markdown";
import { isUnchecked, uncheckedRanges, wordAround } from "./spelling";
import { wikiLinkExtension } from "./wikilinks";
import { hashtagExtension } from "./tags";

const md = parser.configure([GFM, wikiLinkExtension, hashtagExtension]);

function skipped(text: string): string[] {
  return uncheckedRanges(text, md.parse(text), 0, text.length).map((r) => text.slice(r.from, r.to));
}

describe("spell checking skips what is not prose", () => {
  test("prose is checked", () => {
    expect(skipped("A paragraf with a mispelled wrd.\n\n# A hedding\n\n- a lisst *emphasiss*")).toEqual([]);
  });

  test("a fence, its info string included, is skipped as a block", () => {
    const text = "Before.\n\n```bash\necho definately\n```\n\nAfter.";
    const ranges = uncheckedRanges(text, md.parse(text), 0, text.length);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.block).toBe(true);
    expect(text.slice(ranges[0]!.from, ranges[0]!.to)).toBe("```bash\necho definately\n```");
  });

  test("an indented code block and an HTML block are skipped", () => {
    expect(skipped("Para.\n\n    grpe foo\n\n<div class=\"wrng\">\n</div>")).toEqual([
      "grpe foo",
      "<div class=\"wrng\">\n</div>",
    ]);
  });

  test("inline code, URLs and autolinks are skipped, and a link's text is not", () => {
    expect(skipped("Run `grpe` at <https://exampel.com> or https://wrng.io, see [linkk text](https://xn.com).")).toEqual([
      "`grpe`",
      "<https://exampel.com>",
      "https://wrng.io",
      "https://xn.com",
    ]);
  });

  test("wikilinks and tags name things, so they are skipped", () => {
    expect(skipped("See [[Nonexistant Titel]] and #tagg here.")).toEqual(["[[Nonexistant Titel]]", "#tagg"]);
  });

  test("the frontmatter block is skipped, and the line after it is prose", () => {
    const text = "---\ntags: [teh]\n---\nA paragraf.";
    const ranges = uncheckedRanges(text, md.parse(text), 0, text.length);
    expect(ranges).toEqual([{ from: 0, to: text.indexOf("A paragraf"), block: true }]);
  });

  test("a range query returns only what touches the range", () => {
    const text = "`one`\n\nprose here\n\n`two`";
    const from = text.indexOf("prose");
    expect(uncheckedRanges(text, md.parse(text), from, from + 5)).toEqual([]);
  });

  test("isUnchecked answers for one position", () => {
    const text = "Prose `code` prose.";
    const tree = md.parse(text);
    expect(isUnchecked(text, tree, text.indexOf("code"))).toBe(true);
    expect(isUnchecked(text, tree, text.indexOf("Prose"))).toBe(false);
  });
});

describe("the word a right-click names", () => {
  const text = "I dont know, don't ask about e-mail.";
  const at = (word: string, into = 0) => wordAround(text, text.indexOf(word) + into)?.word ?? null;

  test("a click anywhere on a word, its end included, names the whole word", () => {
    expect(at("dont")).toBe("dont");
    expect(at("dont", 2)).toBe("dont");
    expect(at("dont", 4)).toBe("dont");
  });

  test("apostrophes and hyphens inside a word keep it one word", () => {
    expect(at("don't", 4)).toBe("don't");
    expect(at("e-mail", 3)).toBe("e-mail");
  });

  test("a click between words that touches neither names nothing", () => {
    const gap = "a  b";
    expect(wordAround(gap, 2)).toBeNull();
  });

  test("the positions are offsets into the text", () => {
    expect(wordAround(text, text.indexOf("know"))).toEqual({ from: 7, to: 11, word: "know" });
  });
});
