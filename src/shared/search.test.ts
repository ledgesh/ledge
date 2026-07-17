import { describe, expect, test } from "bun:test";
import { MAX_HITS, MAX_HITS_PER_NOTE, collectHits, searchText } from "./search";

describe("searchText", () => {
  test("matches case-insensitively and reports the line 1-based", () => {
    const hits = searchText("hello", "# Title\n\nsay HELLO there\n");
    expect(hits).toEqual([{ line: 3, snippet: "say HELLO there", col: 4 }]);
  });

  test("an empty (or all-whitespace) query matches nothing, not everything", () => {
    expect(searchText("", "anything\n")).toEqual([]);
    expect(searchText("   ", "anything\n")).toEqual([]);
  });

  test("the query is trimmed before matching", () => {
    expect(searchText("  plan  ", "the plan\n")).toEqual([
      { line: 1, snippet: "the plan", col: 4 },
    ]);
  });

  test("one hit per line: a second occurrence on the same line adds nothing", () => {
    const hits = searchText("ab", "ab then ab again\nab once more");
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
    expect(hits[0]!.col).toBe(0);
  });

  test("stops at the per-note limit", () => {
    const text = Array.from({ length: 10 }, () => "match here").join("\n");
    expect(searchText("match", text).length).toBe(MAX_HITS_PER_NOTE);
    expect(searchText("match", text, 2).length).toBe(2);
  });

  test("leading indentation is stripped from the snippet, and col follows", () => {
    const hits = searchText("item", "    - a list item\n");
    expect(hits).toEqual([{ line: 1, snippet: "- a list item", col: 9 }]);
  });

  test("a long line is windowed around the match with ellipses on the cut edges", () => {
    const line = "x".repeat(300) + " needle " + "y".repeat(300);
    const [hit] = searchText("needle", line);
    expect(hit!.snippet.length).toBeLessThan(170);
    expect(hit!.snippet.startsWith("…")).toBe(true);
    expect(hit!.snippet.endsWith("…")).toBe(true);
    // col points at the match inside the window, not the original line.
    expect(hit!.snippet.slice(hit!.col, hit!.col + "needle".length)).toBe("needle");
  });

  test("a match at the start of a long line keeps its head un-elided", () => {
    const [hit] = searchText("needle", "needle " + "y".repeat(300));
    expect(hit!.snippet.startsWith("needle")).toBe(true);
    expect(hit!.col).toBe(0);
    expect(hit!.snippet.endsWith("…")).toBe(true);
  });
});

describe("collectHits", () => {
  const note = (path: string, title: string, mtimeMs: number) => ({ path, title, mtimeMs });

  test("keeps the order the notes arrived in and tags each hit with its note", async () => {
    const texts = new Map([
      ["/n/new.md", "top match\n"],
      ["/n/old.md", "another match\n"],
    ]);
    const hits = await collectHits(
      "match",
      [note("/n/new.md", "New", 2), note("/n/old.md", "Old", 1)],
      (p) => texts.get(p) ?? null,
    );
    expect(hits.map((h) => h.path)).toEqual(["/n/new.md", "/n/old.md"]);
    expect(hits[0]).toMatchObject({ title: "New", mtimeMs: 2, line: 1 });
  });

  test("a note whose text cannot be read costs that note and nothing else", async () => {
    const hits = await collectHits(
      "x",
      [note("/n/gone.md", "Gone", 2), note("/n/here.md", "Here", 1)],
      (p) => (p === "/n/here.md" ? "x marks the spot" : null),
    );
    expect(hits.map((h) => h.title)).toEqual(["Here"]);
  });

  test("stops reading once MAX_HITS is reached", async () => {
    const reads: string[] = [];
    const many = Array.from({ length: 50 }, (_, i) => note(`/n/${i}.md`, `${i}`, 50 - i));
    const hits = await collectHits("m", many, (p) => {
      reads.push(p);
      return Array.from({ length: MAX_HITS_PER_NOTE }, () => "m").join("\n");
    });
    expect(hits.length).toBe(MAX_HITS);
    expect(reads.length).toBe(MAX_HITS / MAX_HITS_PER_NOTE);
  });

  test("an empty query reads nothing", async () => {
    const hits = await collectHits("  ", [note("/n/a.md", "A", 1)], () => {
      throw new Error("should not read");
    });
    expect(hits).toEqual([]);
  });
});
