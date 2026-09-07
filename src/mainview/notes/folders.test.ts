import { describe, expect, test } from "bun:test";
import {
  browserRows,
  countIn,
  favoriteRowId,
  favoriteRows,
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
    // A note at a/b/c.md needs an `a` row to hang `a/b` off. Without it the
    // tree draws `b` at the top level, showing the note in the wrong place.
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
    // A collapsed row shows how many notes are at or below the folder.
    const notes = [
      note("/r/p/one.md", "One", "p"),
      note("/r/p/api/two.md", "Two", "p/api"),
      note("/r/other.md", "Other"),
    ];
    expect(countIn(notes, "p")).toBe(2);
    expect(countIn(notes, "p/api")).toBe(1);
  });

  test("a folder whose name prefixes another's does not borrow its notes", () => {
    // "p" must not count "planning/"'s notes. `folderContains` matches the
    // folder itself, or a path with a "/" after the prefix
    // (shared/folders.ts). A plain startsWith would match here.
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
    // The child stays in the expanded set. Its rows are gone because the walk
    // stops at the collapsed parent and never reaches it.
    const rows = browserRows(notes, new Set(["projects/deep"]), byTitle);
    expect(titles(rows)).toEqual(["admin/", "projects/", "Top"]);
  });

  test("a folder row carries the count of everything below it", () => {
    const rows = browserRows(notes, new Set(), byTitle);
    const projects = rows.find((r) => r.kind === "folder" && r.folder === "projects");
    expect(projects).toMatchObject({ count: 2, expanded: false });
  });

  test("row ids are unique across the two kinds", () => {
    // Folder ids carry a `dir:` prefix because a note's id is its absolute
    // path. NoteBrowser hands the id to useListNav as the row key
    // (lib/useListNav.ts). NoteBrowser also finds a renamed row again by
    // looking its id up in the DOM. A folder row and a note row sharing an
    // id would send a row verb's keystroke to the wrong note.
    const rows = browserRows(notes, new Set(["projects", "projects/deep", "admin"]), byTitle);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(folderRowId("projects")).toBe("dir:projects");
  });

  test("the sort applies within a folder, never across the tree", () => {
    // The sort runs inside each folder. Sorting across the whole list would
    // move a note's row into another folder's group.
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
    // `expandedWith` opens the ancestors along with the folder. A folder
    // whose ancestors stayed collapsed would have its row hidden.
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
    // A rename changes what a folder is called, not which folders are open.
    // The tree looks the same afterwards. The open set is keyed by path, so
    // `expandedRenamed` rewrites the paths under the old name. Without that
    // rewrite every open path under the folder would stop matching and the
    // subtree would collapse.
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

describe("favoriteRows", () => {
  const fav = (path: string, title: string, folder?: string): NoteMeta => ({
    ...note(path, title, folder),
    favorite: true,
  });

  test("only marked notes, sorted, flat", () => {
    // Flat and at depth 0 wherever the note actually sits: the section says
    // which notes, and the tree below says where they are.
    const notes = [fav("/r/p/z.md", "Zebra", "projects"), note("/r/a.md", "Plain"), fav("/r/b.md", "Alpha")];
    const rows = favoriteRows(notes, byTitle);
    expect(rows.map((r) => r.note.title)).toEqual(["Alpha", "Zebra"]);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  test("nothing marked is no section", () => {
    expect(favoriteRows([note("/r/a.md", "Plain")], byTitle)).toEqual([]);
  });

  test("a favorite's two rows carry different ids", () => {
    // The same note is a row here and a row in the tree. One id on both would
    // take the roving tabindex together (lib/useListNav.ts).
    const notes = [fav("/r/a.md", "Alpha")];
    const inTree = browserRows(notes, new Set(), byTitle);
    expect(favoriteRows(notes, byTitle)[0]!.id).not.toBe(inTree[0]!.id);
    expect(favoriteRowId("/r/a.md")).not.toBe("/r/a.md");
  });
});
