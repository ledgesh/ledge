// The note store's tests that touch no filesystem, what is left after the
// rest moved out. uniqueName and isInside went to bun/workspaces.ts with the
// per-workspace split, and their tests to workspaces.test.ts. The path-guard
// refusals that need registered roots live in notes.fs.test.ts, which works
// against a real filesystem and so has real directories to register.
import { describe, expect, test } from "bun:test";
import { deleteTrashed, notesTagged, titleOf } from "./notes";

describe("titleOf", () => {
  test("drops the directory and the extension", () => {
    expect(titleOf("/Users/x/.ledge/scratch/shipping-notes.md")).toBe("shipping-notes");
  });

  test("keeps inner dots", () => {
    expect(titleOf("/Users/x/.ledge/scratch/v1.2.notes.md")).toBe("v1.2.notes");
  });
});

describe("notesTagged", () => {
  test("an empty tag is refused before any filesystem work", async () => {
    // "" and "#" both normalize to nothing. notesTagged throws rather than
    // scanning: a blank query this deep is a caller bug, not a scan that
    // matches nothing.
    expect(notesTagged("/anywhere", "")).rejects.toThrow(/empty tag/);
    expect(notesTagged("/anywhere", "#")).rejects.toThrow(/empty tag/);
  });
});

describe("deleteTrashed", () => {
  test("a path outside every registered root is refused before any filesystem work", async () => {
    // Nothing under /etc or a bare /tmp/.ledge-trash can be a workspace root,
    // whatever other test files have registered. assertTrashed refuses both
    // paths on root membership.
    expect(deleteTrashed("/etc/passwd")).rejects.toThrow(/not a trashed note/);
    expect(deleteTrashed("/tmp/.ledge-trash/x.md")).rejects.toThrow(/not a trashed note/);
  });
});
