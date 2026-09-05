import { describe, expect, test } from "bun:test";
import { folderChoices, usableFolderName } from "./FolderPicker";

const FOLDERS = ["admin", "projects", "projects/api"];

describe("usableFolderName", () => {
  test("takes an ordinary name and a nested path", () => {
    expect(usableFolderName("trips")).toBe(true);
    expect(usableFolderName("projects/api")).toBe(true);
  });

  test("refuses what folderPathOf would refuse", () => {
    // Not the guard — Bun's is — but a row that could only end in a refusal
    // should not be offered in the first place.
    expect(usableFolderName("")).toBe(false);
    expect(usableFolderName("   ")).toBe(false);
    expect(usableFolderName("/absolute")).toBe(false);
    expect(usableFolderName("a\\b")).toBe(false);
    expect(usableFolderName(".hidden")).toBe(false);
    expect(usableFolderName("a/../b")).toBe(false);
    expect(usableFolderName("a//b")).toBe(false);
  });

  test("a trailing slash is trimmed rather than refused", () => {
    // Typing "projects/" on the way to a subfolder is how people type paths.
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
    // New Folder… is not offering to make the workspace folder again.
    expect(folderChoices(FOLDERS, "", false).map((r) => r.folder)).toEqual(FOLDERS);
  });

  test("matching is a substring over the whole path, case-insensitively", () => {
    // The create row rides along because "API" is not itself a folder here:
    // a top-level API beside projects/api is a thing someone may mean.
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
    // Two rows for one outcome, and the create-looking one would be wrong.
    const rows = folderChoices(FOLDERS, "admin", true);
    expect(rows.map((r) => r.folder)).toEqual(["admin"]);
    expect(rows.some((r) => r.create)).toBe(false);
  });

  test("a partial match still offers the create row for what was typed", () => {
    // "proj" matches projects and projects/api, and is also a folder you could
    // mean to make; both are offered, with create last.
    const rows = folderChoices(FOLDERS, "proj", true);
    expect(rows.map((r) => r.folder)).toEqual(["projects", "projects/api", "proj"]);
    expect(rows.at(-1)?.create).toBe(true);
  });

  test("an unusable name matches nothing and offers no create row", () => {
    expect(folderChoices(FOLDERS, "../escape", true)).toEqual([]);
  });
});
