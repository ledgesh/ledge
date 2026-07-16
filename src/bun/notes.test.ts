import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { NOTES_ROOT, TRASH_DIR, deleteTrashed, isInside, titleOf, uniqueName } from "./notes";

describe("uniqueName", () => {
  test("takes the bare name when nothing is taken", () => {
    expect(uniqueName("untitled", new Set())).toBe("untitled.md");
  });

  // APFS is case-insensitive by default, so "Foo.md" and "foo.md" are ONE file on
  // macOS: a case-sensitive check would hand back a name whose rename silently
  // clobbers the other note.
  test("comparison is case-insensitive, so a name cannot collide by case alone", () => {
    expect(uniqueName("untitled", new Set(["UNTITLED.md"]))).toBe("untitled-2.md");
    expect(uniqueName("notes", new Set(["Notes.md", "notes-2.MD"]))).toBe("notes-3.md");
  });

  test("suffixes from 2 upward, skipping every taken name", () => {
    const taken = new Set(["untitled.md", "untitled-2.md", "untitled-3.md"]);
    expect(uniqueName("untitled", taken)).toBe("untitled-4.md");
  });

  test("ignores gaps: the first free suffix wins, not the highest plus one", () => {
    const taken = new Set(["untitled.md", "untitled-3.md"]);
    expect(uniqueName("untitled", taken)).toBe("untitled-2.md");
  });

  test("unrelated names never collide", () => {
    expect(uniqueName("untitled", new Set(["notes.md", "untitled-2.md"]))).toBe("untitled.md");
  });
});

describe("isInside", () => {
  const root = "/Users/x/.ledge";

  test("a note in the root is inside", () => {
    expect(isInside(root, "/Users/x/.ledge/note.md")).toBe(true);
  });

  test("a note in a subfolder is inside", () => {
    expect(isInside(root, "/Users/x/.ledge/work/note.md")).toBe(true);
  });

  test("the root itself is inside", () => {
    expect(isInside(root, root)).toBe(true);
  });

  test("a traversal out of the root is rejected", () => {
    expect(isInside(root, "/Users/x/.ledge/../.ssh/id_rsa")).toBe(false);
  });

  test("a sibling whose name merely starts with the root is rejected", () => {
    // The prefix check must be path-segment aware, not a raw startsWith.
    expect(isInside(root, "/Users/x/.ledge-evil/note.md")).toBe(false);
  });

  test("an unrelated absolute path is rejected", () => {
    expect(isInside(root, "/etc/passwd")).toBe(false);
  });
});

describe("titleOf", () => {
  test("drops the directory and the extension", () => {
    expect(titleOf("/Users/x/.ledge/shipping-notes.md")).toBe("shipping-notes");
  });

  test("keeps inner dots", () => {
    expect(titleOf("/Users/x/.ledge/v1.2.notes.md")).toBe("v1.2.notes");
  });
});

describe("deleteTrashed", () => {
  // The guard is the whole safety story for permanent delete: it unlinks, so
  // "which paths does it accept" is the only thing standing between a Trash
  // row and an arbitrary file the view named. It throws before touching the
  // filesystem, so these cases never reach a real path.
  test("refuses anything that is not a .md directly inside the trash", async () => {
    for (const path of [
      "/etc/passwd",
      join(NOTES_ROOT, "live-note.md"), // a live note, not a trashed one
      join(TRASH_DIR, "sub", "nested.md"), // not directly inside
      join(TRASH_DIR, "notes.txt"), // not a note
      TRASH_DIR, // the folder itself
      join(TRASH_DIR, "..", "escape.md"),
    ]) {
      expect(deleteTrashed(path)).rejects.toThrow(/not a trashed note/);
    }
  });
});
