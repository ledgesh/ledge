import { describe, expect, test } from "bun:test";
import { folderContains, folderLeafProblem, folderNameProblem, folderScopeOf, notesUnder } from "./folders";

const note = (path: string, folder?: string) =>
  ({ path, title: path, mtimeMs: 0, ...(folder === undefined ? {} : { folder }) }) as const;

describe("folderContains", () => {
  test("a folder contains itself and everything below it", () => {
    expect(folderContains("projects", "projects")).toBe(true);
    expect(folderContains("projects", "projects/api")).toBe(true);
    expect(folderContains("projects", "projects/api/v2")).toBe(true);
  });

  test("a folder does not contain its sibling with the same prefix", () => {
    // A regression guard: a prefix test without the `/` made `ab` a child
    // of `a` (folders.ts, folderContains).
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

describe("folderNameProblem", () => {
  test("an ordinary folder, nested or not, has no problem", () => {
    expect(folderNameProblem("projects")).toBeNull();
    expect(folderNameProblem("projects/api/v2")).toBeNull();
    expect(folderNameProblem("projects/")).toBeNull();
  });

  test("the root is a folder name too", () => {
    expect(folderNameProblem("")).toBeNull();
    expect(folderNameProblem("  ")).toBeNull();
  });

  test("every way of naming somewhere else is a problem, and says which", () => {
    expect(folderNameProblem("/etc")).toBe("folders are relative to the workspace");
    expect(folderNameProblem(" /etc")).toBe("folders are relative to the workspace");
    // folderNameProblem tests for a leading slash before it strips trailing
    // ones. Otherwise `/` would reduce to "", meaning the root, and pass.
    expect(folderNameProblem("/")).toBe("folders are relative to the workspace");
    expect(folderNameProblem("a\\b")).toBe("use / to separate segments");
    expect(folderNameProblem("../escape")).toContain('".." segments');
    expect(folderNameProblem("a/../b")).toContain('".." segments');
    expect(folderNameProblem("a//b")).toContain("empty");
    expect(folderNameProblem(".ledge-trash")).toContain("dot-folders");
    expect(folderNameProblem("a/.git")).toContain("dot-folders");
  });
});

describe("folderLeafProblem", () => {
  test("an ordinary name has no problem", () => {
    expect(folderLeafProblem("projects")).toBeNull();
    expect(folderLeafProblem("  projects  ")).toBeNull();
  });

  test("the root is a folder path and not a folder name", () => {
    // folderNameProblem allows "". The root is where notes lived before
    // folders. Only folderLeafProblem refuses it.
    expect(folderLeafProblem("")).toBe("a folder needs a name");
    expect(folderLeafProblem("   ")).toBe("a folder needs a name");
  });

  test("a path is refused, because a rename does not move the folder", () => {
    expect(folderLeafProblem("deep/new")).toBe("a rename names a folder, it does not move it");
    expect(folderLeafProblem("/etc")).toBe("a rename names a folder, it does not move it");
  });

  test("everything folderNameProblem refuses is still refused, in its words", () => {
    expect(folderLeafProblem("..")).toContain('".." segments');
    expect(folderLeafProblem(".git")).toContain("dot-folders");
    expect(folderLeafProblem("a\\b")).toBe("use / to separate segments");
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
