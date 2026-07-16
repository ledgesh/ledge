import { describe, expect, test } from "bun:test";
import type { NoteMeta } from "./channel";
import { filterNotes, fuzzyScore } from "./fuzzy";

const note = (title: string): NoteMeta => ({ path: `/notes/${title}.md`, title, mtimeMs: 0 });

describe("fuzzyScore", () => {
  test("an empty query matches everything", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  test("an exact match scores", () => {
    expect(fuzzyScore("notes", "notes")).not.toBeNull();
  });

  test("matches a scattered subsequence", () => {
    expect(fuzzyScore("shnt", "shipping-notes")).not.toBeNull();
  });

  test("is case-insensitive both ways", () => {
    expect(fuzzyScore("SHIP", "shipping")).not.toBeNull();
    expect(fuzzyScore("ship", "SHIPPING")).not.toBeNull();
  });

  test("rejects characters that are absent", () => {
    expect(fuzzyScore("xyz", "shipping-notes")).toBeNull();
  });

  test("rejects a subsequence in the wrong order", () => {
    // Both letters are present, but "n" does not follow an "s" that follows it.
    expect(fuzzyScore("sn", "notes")).toBeNull();
  });

  test("rejects a query longer than the text", () => {
    expect(fuzzyScore("noteses", "notes")).toBeNull();
  });

  test("adjacent matches beat scattered ones", () => {
    const adjacent = fuzzyScore("ship", "shipping")!;
    const scattered = fuzzyScore("ship", "sxhxixp")!;
    expect(adjacent).toBeGreaterThan(scattered);
  });

  test("a word-boundary match beats a mid-word one", () => {
    const boundary = fuzzyScore("n", "shipping-notes")!;
    const midWord = fuzzyScore("n", "shipping")!;
    expect(boundary).toBeGreaterThan(midWord);
  });
});

describe("filterNotes", () => {
  test("an empty query keeps every note, sorted by title", () => {
    const notes = [note("zeta"), note("alpha"), note("mid")];
    expect(filterNotes("", notes).map((n) => n.title)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("drops non-matches", () => {
    const notes = [note("shipping-notes"), note("groceries")];
    expect(filterNotes("ship", notes).map((n) => n.title)).toEqual(["shipping-notes"]);
  });

  test("ranks the better match first", () => {
    const notes = [note("some-hidden-plans"), note("shipping")];
    // "shipping" is a clean prefix run; "some-hidden-plans" only matches scattered.
    expect(filterNotes("ship", notes)[0]!.title).toBe("shipping");
  });

  test("ties break on title, so the order never depends on input order", () => {
    const a = filterNotes("note", [note("note-b"), note("note-a")]);
    const b = filterNotes("note", [note("note-a"), note("note-b")]);
    expect(a.map((n) => n.title)).toEqual(["note-a", "note-b"]);
    expect(b.map((n) => n.title)).toEqual(["note-a", "note-b"]);
  });

  test("whitespace around the query is ignored", () => {
    expect(filterNotes("  ship  ", [note("shipping")]).map((n) => n.title)).toEqual(["shipping"]);
  });
});
