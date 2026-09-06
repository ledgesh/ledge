import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { APP_HOME, isInside, kindOf, uniqueName } from "./workspaces";

// uniqueName and isInside moved here from notes.ts with the per-workspace
// split, and these tests moved with them. They guard workspace folders now,
// not just notes.

describe("uniqueName", () => {
  test("takes the bare name when nothing is taken", () => {
    expect(uniqueName("untitled", new Set())).toBe("untitled.md");
  });

  // On macOS, APFS is case-insensitive by default: an existing "Foo.md" and a
  // wanted "foo.md" are one file. A case-sensitive check would hand back a
  // name whose rename silently clobbers the existing note.
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
  // kind is derived from location, never stored, so the registry file can
  // store bare paths. A direct child of APP_HOME is "managed". Anything else
  // is "external". The docs folder is the exception: it sits directly under
  // APP_HOME, and kindOf returns "docs" for it.
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
