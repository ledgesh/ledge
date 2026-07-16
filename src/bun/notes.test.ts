import { describe, expect, test } from "bun:test";
import { isInside, titleOf, uniqueName } from "./notes";

describe("uniqueName", () => {
  test("takes the bare name when nothing is taken", () => {
    expect(uniqueName("untitled", new Set())).toBe("untitled.md");
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
