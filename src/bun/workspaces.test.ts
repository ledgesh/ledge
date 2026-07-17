import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { APP_HOME, isInside, kindOf, uniqueName } from "./workspaces";

// uniqueName and isInside moved here from notes.ts with the per-workspace
// split (they guard workspace folders now too); their tests moved with them.

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

  test("another extension allocates the same way — image assets share the allocator", () => {
    expect(uniqueName("pasted-2026-07-17", new Set(), ".png")).toBe("pasted-2026-07-17.png");
    expect(uniqueName("pasted-2026-07-17", new Set(["Pasted-2026-07-17.PNG"]), ".png")).toBe(
      "pasted-2026-07-17-2.png",
    );
  });

  test("an empty extension allocates workspace folder names", () => {
    expect(uniqueName("scratch", new Set(), "")).toBe("scratch");
    expect(uniqueName("scratch", new Set(["Scratch", "scratch-2"]), "")).toBe("scratch-3");
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

describe("kindOf", () => {
  // kind is a fact about location, never a stored field: managed means "a
  // direct child of APP_HOME", full stop. That equivalence is what lets the
  // registry file carry bare paths.
  test("a direct child of the app home is managed", () => {
    expect(kindOf(join(APP_HOME, "scratch"))).toBe("managed");
  });

  test("a deeper descendant is external, not managed", () => {
    expect(kindOf(join(APP_HOME, "scratch", "sub"))).toBe("external");
  });

  test("anywhere else is external", () => {
    expect(kindOf("/Users/x/Projects/notes")).toBe("external");
  });
});
