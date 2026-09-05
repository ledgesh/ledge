import { describe, expect, test } from "bun:test";
import { folderContains, folderScopeOf, notesUnder } from "./folders";

const note = (path: string, folder?: string) =>
  ({ path, title: path, mtimeMs: 0, ...(folder === undefined ? {} : { folder }) }) as const;

describe("folderContains", () => {
  test("a folder contains itself and everything below it", () => {
    expect(folderContains("projects", "projects")).toBe(true);
    expect(folderContains("projects", "projects/api")).toBe(true);
    expect(folderContains("projects", "projects/api/v2")).toBe(true);
  });

  test("a folder does not contain its sibling with the same prefix", () => {
    // The bug the `/` in the prefix test exists to prevent.
    expect(folderContains("a", "ab")).toBe(false);
    expect(folderContains("projects", "projects-old")).toBe(false);
  });

  test("a folder does not contain its parent", () => {
    expect(folderContains("projects/api", "projects")).toBe(false);
  });

  test("the root contains everything, itself included", () => {
    expect(folderContains("", "")).toBe(true);
    expect(folderContains("", "projects/api")).toBe(true);
  });
});

describe("folderScopeOf", () => {
  test("absent, null and blank all mean the root", () => {
    expect(folderScopeOf(undefined)).toBe("");
    expect(folderScopeOf(null)).toBe("");
    expect(folderScopeOf("   ")).toBe("");
    expect(folderScopeOf(7)).toBe("");
  });

  test("a trailing slash is how a shell user spells a folder", () => {
    expect(folderScopeOf("projects/")).toBe("projects");
    expect(folderScopeOf(" projects/api// ")).toBe("projects/api");
  });
});

describe("notesUnder", () => {
  const notes = [note("/a.md"), note("/p/b.md", "projects"), note("/p/api/c.md", "projects/api"), note("/ab/d.md", "ab")];

  test("no scope selects every note", () => {
    expect(notesUnder(notes, "").length).toBe(4);
  });

  test("a scope selects the folder and its descendants, not its namesake sibling", () => {
    expect(notesUnder(notes, "projects").map((n) => n.path)).toEqual(["/p/b.md", "/p/api/c.md"]);
    expect(notesUnder(notes, "projects/api").map((n) => n.path)).toEqual(["/p/api/c.md"]);
  });

  test("a folder nothing is in selects nothing, and that is not an error", () => {
    expect(notesUnder(notes, "nope")).toEqual([]);
  });
});
