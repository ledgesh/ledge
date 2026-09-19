// Tests for relevantChange, the event filter that is the pure half of
// bun/watch.ts. The filter decides which filesystem events should refresh
// the view.
import { describe, expect, test } from "bun:test";
import { relevantChange } from "./watch";

describe("relevantChange", () => {
  test("a plain note anywhere under the root counts, at any depth", () => {
    expect(relevantChange("plan.md")).toBe(true);
    expect(relevantChange("sub/folder/plan.md")).toBe(true);
    expect(relevantChange("PLAN.MD")).toBe(true); // APFS is case-insensitive; so is the filter
  });

  test("a null filename counts, conservatively: a refresh too many beats stale UI", () => {
    expect(relevantChange(null)).toBe(true);
  });

  test("a temp-plus-rename save counts under its temp name too, since the note's name is inside it", () => {
    // Bun before 1.4 could report such a save under the temp name alone. So
    // the filter accepts a ".md" followed by a dot, not only one at the end of
    // the name. Requiring a trailing ".md" blinded the watcher to Ledge's own
    // saves then.
    expect(relevantChange(".plan.md.tmp-123-1")).toBe(true);
    expect(relevantChange("sub/.plan.md.tmp-123-1")).toBe(true);
  });

  test("dotted directories do not count: .git churn, trash-internal moves, editor state dirs", () => {
    expect(relevantChange(".ledge-trash/plan.md")).toBe(false);
    expect(relevantChange(".git/COMMIT_EDITMSG")).toBe(false);
    expect(relevantChange("sub/.hidden/plan.md")).toBe(false);
  });

  test("non-.md files do not count: they can appear in no list the view shows", () => {
    expect(relevantChange("photo.png")).toBe(false);
    expect(relevantChange("src/index.ts")).toBe(false);
    expect(relevantChange("mdish.mdx")).toBe(false);
    expect(relevantChange("plan.mdx")).toBe(false);
  });
});
