import { describe, expect, test } from "bun:test";
import { folderChoices, usableFolderName } from "./FolderPicker";

const FOLDERS = ["admin", "projects", "projects/api"];

describe("usableFolderName", () => {
  test("takes an ordinary name and a nested path", () => {
    expect(usableFolderName("trips")).toBe(true);
    expect(usableFolderName("projects/api")).toBe(true);
  });

  test("refuses what folderPathOf would refuse", () => {
    // usableFolderName repeats the shape rules in shared/folders.ts
    // folderNameProblem, so a name of the wrong shape gets no create row. Bun
    // refuses more than shape: folderPathOf rejects a name that resolves
    // outside the root, ensureFolder one that .ledgeignore hides
    // (bun/notes.ts). Those refusals reach the user through the error branch
    // in NoteBrowser's picked().
    expect(usableFolderName("")).toBe(false);
    expect(usableFolderName("   ")).toBe(false);
    expect(usableFolderName("/absolute")).toBe(false);
    expect(usableFolderName("a\\b")).toBe(false);
    expect(usableFolderName(".hidden")).toBe(false);
    expect(usableFolderName("a/../b")).toBe(false);
    expect(usableFolderName("a//b")).toBe(false);
  });

  test("a trailing slash is trimmed rather than refused", () => {
    // usableFolderName strips a trailing slash before checking the shape.
    // Typing "projects/" on the way to a subfolder is how people type a path,
    // not a malformed name, so it passes.
    expect(usableFolderName("projects/")).toBe(true);
  });
});

describe("folderChoices", () => {
  test("an empty query lists the top level and every folder", () => {
    const rows = folderChoices(FOLDERS, "", true);
    expect(rows.map((r) => r.folder)).toEqual([null, "admin", "projects", "projects/api"]);
    expect(rows.some((r) => r.create)).toBe(false);
  });

  test("the top level is withheld where it is not a destination", () => {
    // The New Folder request gets allowRoot false, from the
    // `allowRoot={picking.kind === "move"}` in notes/NoteBrowser.tsx. The
    // workspace's top level already exists, so New Folder has nothing to
    // create there.
    expect(folderChoices(FOLDERS, "", false).map((r) => r.folder)).toEqual(FOLDERS);
  });

  test("matching is a substring over the whole path, case-insensitively", () => {
    // The create row is offered too. It is suppressed only when a folder's
    // whole path equals the query, lowercased, and no folder here is called
    // "api". A top-level API beside projects/api is a folder someone may mean
    // to make.
    const rows = folderChoices(FOLDERS, "API", true);
    expect(rows.map((r) => r.folder)).toEqual(["projects/api", "API"]);
    expect(rows[0]?.create).toBeUndefined();
  });

  test("a query naming no folder offers to create it, last", () => {
    const rows = folderChoices(FOLDERS, "trips", true);
    expect(rows.map((r) => r.folder)).toEqual(["trips"]);
    expect(rows.at(-1)).toMatchObject({ create: true, folder: "trips" });
  });

  test("a query naming an existing folder exactly offers no create row", () => {
    // The existing folder is already a row. A create row for the same name
    // would be a second row for one outcome, and it would read "New folder"
    // under a FolderPlus icon when nothing new is made.
    const rows = folderChoices(FOLDERS, "admin", true);
    expect(rows.map((r) => r.folder)).toEqual(["admin"]);
    expect(rows.some((r) => r.create)).toBe(false);
  });

  test("a partial match still offers the create row for what was typed", () => {
    // "proj" matches projects and projects/api, and no folder has that name.
    // Both matches are listed, then the create row.
    const rows = folderChoices(FOLDERS, "proj", true);
    expect(rows.map((r) => r.folder)).toEqual(["projects", "projects/api", "proj"]);
    expect(rows.at(-1)?.create).toBe(true);
  });

  test("an unusable name matches nothing and offers no create row", () => {
    expect(folderChoices(FOLDERS, "../escape", true)).toEqual([]);
  });
});
