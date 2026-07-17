// The store's pure remainders. uniqueName and isInside moved to
// bun/workspaces.ts with the per-workspace split (their tests moved to
// workspaces.test.ts); the path-guard refusals that need registered roots
// live in notes.fs.test.ts, where roots exist to register.
import { describe, expect, test } from "bun:test";
import { deleteTrashed, titleOf } from "./notes";

describe("titleOf", () => {
  test("drops the directory and the extension", () => {
    expect(titleOf("/Users/x/.ledge/scratch/shipping-notes.md")).toBe("shipping-notes");
  });

  test("keeps inner dots", () => {
    expect(titleOf("/Users/x/.ledge/scratch/v1.2.notes.md")).toBe("v1.2.notes");
  });
});

describe("deleteTrashed", () => {
  test("a path outside every registered root is refused before any filesystem work", async () => {
    // Whatever other test files registered, nothing under /etc or a bare
    // /tmp/.ledge-trash can be a workspace root: these fail on root membership.
    expect(deleteTrashed("/etc/passwd")).rejects.toThrow(/not a trashed note/);
    expect(deleteTrashed("/tmp/.ledge-trash/x.md")).rejects.toThrow(/not a trashed note/);
  });
});
