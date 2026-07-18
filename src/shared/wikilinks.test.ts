// The pure wikilink decisions: how a target splits into title + heading,
// which note a title resolves to, and what a backlink scan counts as a link.
// (The `[[...]]` grammar and the picker are CodeMirror seams, tested in
// mainview/editor/wikilinks.test.ts.)
import { describe, expect, test } from "bun:test";
import { parseWikiTarget, resolveWikiTitle, wikiRefsOf } from "./wikilinks";

const note = (title: string, path = `/ws/${title}.md`) => ({ path, title });

describe("parseWikiTarget", () => {
  test("a bare title has no heading", () => {
    expect(parseWikiTarget("Meeting Notes")).toEqual({ title: "Meeting Notes", heading: null });
  });

  test("the first # splits title from heading, both trimmed", () => {
    expect(parseWikiTarget(" Notes # Setup ")).toEqual({ title: "Notes", heading: "Setup" });
  });

  test("a heading may itself contain # (only the first splits)", () => {
    expect(parseWikiTarget("Notes#a#b")).toEqual({ title: "Notes", heading: "a#b" });
  });

  test("a trailing bare # is no heading", () => {
    expect(parseWikiTarget("Notes#")).toEqual({ title: "Notes", heading: null });
  });

  test("no title means no target — [[#h]] and whitespace are dangling by construction", () => {
    expect(parseWikiTarget("#Setup")).toBeNull();
    expect(parseWikiTarget("   ")).toBeNull();
  });
});

describe("resolveWikiTitle", () => {
  const notes = [note("Alpha"), note("beta"), note("Beta", "/ws/Beta-2.md")];

  test("exact title match wins", () => {
    expect(resolveWikiTitle("Alpha", notes)?.path).toBe("/ws/Alpha.md");
  });

  test("matching is case-insensitive, but an exact-case hit beats a folded one", () => {
    expect(resolveWikiTitle("BETA", notes)?.path).toBe("/ws/beta.md");
    expect(resolveWikiTitle("Beta", notes)?.path).toBe("/ws/Beta-2.md");
  });

  test("no fuzz: a near-miss is dangling, never the nearest note", () => {
    expect(resolveWikiTitle("Alphas", notes)).toBeNull();
  });

  test("titles compare trimmed on both sides", () => {
    expect(resolveWikiTitle("  alpha  ", notes)?.path).toBe("/ws/Alpha.md");
  });
});

describe("wikiRefsOf", () => {
  test("finds every link with its 1-based line", () => {
    expect(wikiRefsOf("a [[One]] b\nplain\nsee [[Two#Setup]] and [[Three]]")).toEqual([
      { title: "One", heading: null, line: 1 },
      { title: "Two", heading: "Setup", line: 3 },
      { title: "Three", heading: null, line: 3 },
    ]);
  });

  test("mirrors the grammar's refusals: empty, bracketed, and multi-line stay raw", () => {
    expect(wikiRefsOf("x [[]] y")).toEqual([]);
    expect(wikiRefsOf("x [[a](url) y")).toEqual([]);
    expect(wikiRefsOf("a [[first\nsecond]] b")).toEqual([]);
    expect(wikiRefsOf("a [[half] b]]")).toEqual([]);
  });

  test("a dangling-by-construction target ([[#h]]) is not a ref", () => {
    expect(wikiRefsOf("x [[#Setup]] y")).toEqual([]);
  });

  test("fenced code is not scanned — pasted logs are not links", () => {
    expect(wikiRefsOf("```\n[[Not A Link]]\n```\n[[Real]]")).toEqual([
      { title: "Real", heading: null, line: 4 },
    ]);
  });

  test("a fence closes only on its own character and length", () => {
    // The ~~~ line inside a ``` fence is content, and a shorter ```` closer
    // does not close a ````` fence.
    expect(wikiRefsOf("```\n~~~\n[[A]]\n```\n[[B]]")).toEqual([{ title: "B", heading: null, line: 5 }]);
    expect(wikiRefsOf("`````\n```\n[[A]]\n`````\n[[B]]")).toEqual([{ title: "B", heading: null, line: 5 }]);
  });

  test("an unclosed fence swallows the rest of the note", () => {
    expect(wikiRefsOf("```\n[[A]]")).toEqual([]);
  });
});
