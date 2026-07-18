// The watcher's event filter — the pure half of bun/watch.ts. What may wake
// the view is a policy, and these are its statements.
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

  test("a temp-plus-rename save counts UNDER ITS TEMP NAME — the platform reports it no other way", () => {
    // The one event a coalesced atomic save fires is named for the dotted temp
    // file; the note's name is embedded in it. Filtering this out blinds the
    // watcher to Ledge's own saves and to atomic-writing agents.
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
