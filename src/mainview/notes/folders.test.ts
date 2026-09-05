import { describe, expect, test } from "bun:test";
import {
  browserRows,
  countIn,
  expandedRenamed,
  expandedWith,
  expandedWithout,
  folderList,
  folderRowId,
  nameOf,
  parentOf,
} from "./folders";
import type { NoteMeta } from "../../shared/rpc-schema";

const note = (path: string, title: string, folder?: string): NoteMeta => ({
  path,
  title,
  mtimeMs: 0,
  ...(folder ? { folder } : {}),
});

const byTitle = (a: NoteMeta, b: NoteMeta) => a.title.localeCompare(b.title);
const titles = (rows: ReturnType<typeof browserRows>) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "folder" ? `${r.name}/` : r.note.title}`);

describe("folder paths", () => {
  test("a name is the last segment and a parent is everything before it", () => {
    expect(nameOf("projects/api")).toBe("api");
    expect(parentOf("projects/api")).toBe("projects");
    expect(nameOf("projects")).toBe("projects");
    expect(parentOf("projects")).toBe("");
  });
});

describe("folderList", () => {
  test("every ancestor is a folder, even one holding no note of its own", () => {
    // The reason this exists: a note at a/b/c.md needs an `a` row to hang `a/b`
    // off, or the tree draws `b` at the top level and says the note is
    // somewhere it is not.
    const notes = [note("/r/a/b/c.md", "C", "a/b")];
    expect(folderList(notes)).toEqual(["a", "a/b"]);
  });

  test("a workspace with no folders lists none", () => {
    expect(folderList([note("/r/one.md", "One")])).toEqual([]);
  });

  test("folders are deduplicated and sorted", () => {
    const notes = [
      note("/r/z/one.md", "One", "z"),
      note("/r/a/two.md", "Two", "a"),
      note("/r/a/three.md", "Three", "a"),
    ];
    expect(folderList(notes)).toEqual(["a", "z"]);
  });
});

describe("countIn", () => {
  test("a folder counts the notes below it, not only its own", () => {
    // What the collapsed row is hiding — which is the number worth showing.
    const notes = [
      note("/r/p/one.md", "One", "p"),
      note("/r/p/api/two.md", "Two", "p/api"),
      note("/r/other.md", "Other"),
    ];
    expect(countIn(notes, "p")).toBe(2);
    expect(countIn(notes, "p/api")).toBe(1);
  });

  test("a folder whose name prefixes another's does not borrow its notes", () => {
    // "p" must not count "planning/"'s notes: the separator is what makes a
    // prefix a path, and startsWith without it is the classic version of this bug.
    const notes = [note("/r/planning/one.md", "One", "planning")];
    expect(countIn(notes, "p")).toBe(0);
  });
});

describe("browserRows", () => {
  const notes = [
    note("/r/top.md", "Top"),
    note("/r/projects/api.md", "API", "projects"),
    note("/r/projects/deep/spec.md", "Spec", "projects/deep"),
    note("/r/admin/tax.md", "Tax", "admin"),
  ];

  test("folders come before notes at each level, both alphabetical", () => {
    const rows = browserRows(notes, new Set(["admin", "projects", "projects/deep"]), byTitle);
    expect(titles(rows)).toEqual([
      "admin/",
      "  Tax",
      "projects/",
      "  deep/",
      "    Spec",
      "  API",
      "Top",
    ]);
  });

  test("a collapsed folder emits its row and hides everything under it", () => {
    const rows = browserRows(notes, new Set(["admin"]), byTitle);
    expect(titles(rows)).toEqual(["admin/", "  Tax", "projects/", "Top"]);
  });

  test("collapsing a parent hides an expanded child's rows too", () => {
    // The child stays expanded in the set; what decides is whether the walk
    // ever reaches it.
    const rows = browserRows(notes, new Set(["projects/deep"]), byTitle);
    expect(titles(rows)).toEqual(["admin/", "projects/", "Top"]);
  });

  test("a folder row carries the count of everything below it", () => {
    const rows = browserRows(notes, new Set(), byTitle);
    const projects = rows.find((r) => r.kind === "folder" && r.folder === "projects");
    expect(projects).toMatchObject({ count: 2, expanded: false });
  });

  test("row ids are unique across the two kinds", () => {
    // Folder ids are prefixed because a note's id is its absolute path, and
    // useListNav moves focus by id: two rows answering to one id is a
    // keystroke landing on the wrong note.
    const rows = browserRows(notes, new Set(["projects", "projects/deep", "admin"]), byTitle);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(folderRowId("projects")).toBe("dir:projects");
  });

  test("the sort applies within a folder, never across the tree", () => {
    // A global sort is the one thing that would lift a note out of its group.
    const rows = browserRows(
      [note("/r/zzz.md", "Zzz"), note("/r/p/aaa.md", "Aaa", "p")],
      new Set(["p"]),
      byTitle,
    );
    expect(titles(rows)).toEqual(["p/", "  Aaa", "Zzz"]);
  });
});

describe("expansion", () => {
  test("expanding a folder expands its ancestors", () => {
    // A row you cannot see is not revealed by expanding it.
    expect([...expandedWith(new Set(), "a/b/c")].sort()).toEqual(["a", "a/b", "a/b/c"]);
  });

  test("collapsing a folder collapses its descendants", () => {
    const next = expandedWithout(new Set(["a", "a/b", "a/b/c", "ab"]), "a/b");
    expect([...next].sort()).toEqual(["a", "ab"]);
  });

  test("collapsing does not take a folder whose name merely prefixes it", () => {
    expect([...expandedWithout(new Set(["a", "ab"]), "a")]).toEqual(["ab"]);
  });

  test("renaming a folder renames what is open under it, and opens nothing new", () => {
    // A rename changes what folders are CALLED and not which are open, so the
    // tree must look exactly the same afterwards. Keyed by path, so without
    // this every open row under the folder would simply stop matching and the
    // subtree would collapse itself.
    const next = expandedRenamed(new Set(["projcts", "projcts/api", "admin"]), "projcts", "projects");
    expect([...next].sort()).toEqual(["admin", "projects", "projects/api"]);
  });

  test("renaming does not take a folder whose name merely prefixes it", () => {
    expect([...expandedRenamed(new Set(["a", "ab"]), "a", "c")].sort()).toEqual(["ab", "c"]);
  });

  test("a collapsed folder stays collapsed under its new name", () => {
    expect([...expandedRenamed(new Set(["admin"]), "projcts", "projects")]).toEqual(["admin"]);
  });
});
