import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "./frontmatter";
import { inlineTagsOfLine, normalizeTag, tagDirectoryOf, tagRefsOf } from "./tags";

describe("normalizeTag", () => {
  test("folds case and strips a leading #, from either spelling", () => {
    expect(normalizeTag("#Work")).toBe("work");
    expect(normalizeTag("Work")).toBe("work");
    expect(normalizeTag("project/Ledge")).toBe("project/ledge");
  });
});

describe("inlineTagsOfLine", () => {
  test("a heading is never a tag: the space after # is the difference", () => {
    expect(inlineTagsOfLine("# Title")).toEqual([]);
    expect(inlineTagsOfLine("## Section")).toEqual([]);
  });

  test("a line-start #word is a tag — CommonMark says it is not a heading", () => {
    expect(inlineTagsOfLine("#work")).toEqual([{ tag: "work", col: 0, raw: "#work" }]);
  });

  test("mid-line tags need whitespace before the #", () => {
    expect(inlineTagsOfLine("done today #work #home")).toEqual([
      { tag: "work", col: 11, raw: "#work" },
      { tag: "home", col: 17, raw: "#home" },
    ]);
    // A # glued to a word is a fragment or a typo, not a tag.
    expect(inlineTagsOfLine("see https://x.test/page#anchor")).toEqual([]);
    expect(inlineTagsOfLine("word#tag")).toEqual([]);
  });

  test("the token needs a letter or _: years and issue numbers stay text", () => {
    expect(inlineTagsOfLine("#123 #2024")).toEqual([]);
    expect(inlineTagsOfLine("#fff")).toEqual([{ tag: "fff", col: 0, raw: "#fff" }]);
    expect(inlineTagsOfLine("#_draft")).toEqual([{ tag: "_draft", col: 0, raw: "#_draft" }]);
    // Digits are fine once a letter anchors the tag.
    expect(inlineTagsOfLine("#v2")).toEqual([{ tag: "v2", col: 0, raw: "#v2" }]);
  });

  test("## is neither a tag nor two", () => {
    expect(inlineTagsOfLine("##tag")).toEqual([]);
    expect(inlineTagsOfLine("a ##tag b")).toEqual([]);
  });

  test("punctuation ends a tag; / and - are part of one", () => {
    expect(inlineTagsOfLine("#work.")).toEqual([{ tag: "work", col: 0, raw: "#work" }]);
    expect(inlineTagsOfLine("(#work)")).toEqual([]); // "(" is not whitespace
    expect(inlineTagsOfLine("#project/ledge #well-known")).toEqual([
      { tag: "project/ledge", col: 0, raw: "#project/ledge" },
      { tag: "well-known", col: 15, raw: "#well-known" },
    ]);
  });

  test("tags speak any script", () => {
    expect(inlineTagsOfLine("#café #日本語")).toEqual([
      { tag: "café", col: 0, raw: "#café" },
      { tag: "日本語", col: 6, raw: "#日本語" },
    ]);
  });

  test("a lone # is nothing", () => {
    expect(inlineTagsOfLine("#")).toEqual([]);
    expect(inlineTagsOfLine("a # b")).toEqual([]);
  });
});

describe("tagRefsOf", () => {
  test("body tags come back per occurrence, located by 1-based line", () => {
    const refs = tagRefsOf("# Title\n\nnotes #work\nmore #work #home\n");
    expect(refs).toEqual([
      { tag: "work", line: 3, raw: "#work" },
      { tag: "work", line: 4, raw: "#work" },
      { tag: "home", line: 4, raw: "#home" },
    ]);
  });

  test("a fenced block is code, not tags — unclosed fences swallow to the end", () => {
    expect(tagRefsOf("# T\n```\n#not-a-tag\n```\n#real\n")).toEqual([
      { tag: "real", line: 5, raw: "#real" },
    ]);
    expect(tagRefsOf("# T\n```\n#swallowed\n")).toEqual([]);
  });

  test("frontmatter tags point at the tags: line, spelled as written", () => {
    const refs = tagRefsOf("---\ntags: work, #home\n---\n# Title\n");
    expect(refs).toEqual([
      { tag: "work", line: 2, raw: "work" },
      { tag: "home", line: 2, raw: "#home" },
    ]);
  });

  test("a bracketed list points at the same line, its tokens spelled bare", () => {
    const refs = tagRefsOf("---\ntags: [ops, #runbook]\n---\n# Title\n");
    expect(refs).toEqual([
      { tag: "ops", line: 2, raw: "ops" },
      { tag: "runbook", line: 2, raw: "#runbook" },
    ]);
    // `raw` is what a reveal re-finds on the line, so stripping the brackets
    // must leave every token a verbatim substring of it.
    for (const r of refs) expect("tags: [ops, #runbook]").toContain(r.raw);
  });

  test("frontmatter and body merge, frontmatter first", () => {
    const refs = tagRefsOf("---\ncwd: /x\ntags: work\n---\n# Title\n#home\n");
    expect(refs).toEqual([
      { tag: "work", line: 3, raw: "work" },
      { tag: "home", line: 6, raw: "#home" },
    ]);
  });

  test("the block itself is never scanned for inline tags", () => {
    // "#" opens a comment there, and values legitimately contain # (URLs).
    const refs = tagRefsOf("---\n# a note about #stuff\nenv:\n  URL: https://x/#frag\n---\n# T\n");
    expect(refs).toEqual([]);
  });

  // The walk in tagRefsOf and the switch in parseFrontmatter locate the
  // `tags:` key independently; these hold them to the same answer.
  const agreeing = [
    "---\ntags: work\ntags: home\n---\n# T\n", // repeated line replaces
    "---\ntags: work\ntags:\n---\n# T\n", // empty repeat keeps the earlier list
    "---\nenv:\n  tags: not-a-tag-key\n---\n# T\n", // indented tags: is an env var
    "---\n# tags: commented out\n---\n# T\n", // comment line is not the key
    "---\ntags: Work work 123\n---\n# T\n", // dedupe + per-token degradation
    '---\ntags: "work home"\n---\n# T\n', // quoted values unquote first
    "---\ntags: [work, home]\n---\n# T\n", // the bracketed list, unbracketed once
    "---\ntags: [work\n---\n# T\n", // an unmatched bracket refuses its token
    "---\ntags: []\n---\n# T\n", // an explicitly empty list is empty, not absent
    "---\ntags: work\ntags: []\n---\n# T\n", // and it replaces, like any repeat
  ];
  test("frontmatter refs agree with parseFrontmatter on every discipline", () => {
    for (const text of agreeing) {
      const fromRefs = tagRefsOf(text).map((r) => r.tag);
      expect(fromRefs).toEqual(parseFrontmatter(text).params.tags);
    }
  });
});

describe("tagDirectoryOf", () => {
  const ref = (tag: string, line = 1) => ({ tag, line, raw: `#${tag}` });

  test("counts notes bearing a tag, not occurrences, alphabetical", () => {
    const dir = tagDirectoryOf([
      { path: "/a.md", refs: [ref("work"), ref("work", 2)] },
      { path: "/b.md", refs: [ref("work"), ref("home")] },
    ]);
    expect(dir).toEqual([
      { tag: "home", count: 1 },
      { tag: "work", count: 2 },
    ]);
  });

  test("identity folds case; display is the most frequent spelling", () => {
    const dir = tagDirectoryOf([
      { path: "/a.md", refs: [ref("Work"), ref("Work", 2)] },
      { path: "/b.md", refs: [ref("work")] },
    ]);
    expect(dir).toEqual([{ tag: "Work", count: 2 }]);
  });

  test("a spelling tie goes to the first seen — list order is newest-first", () => {
    const dir = tagDirectoryOf([
      { path: "/new.md", refs: [ref("Home")] },
      { path: "/old.md", refs: [ref("home")] },
    ]);
    expect(dir).toEqual([{ tag: "Home", count: 2 }]);
  });
});
