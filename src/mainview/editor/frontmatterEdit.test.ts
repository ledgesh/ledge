import { describe, expect, test } from "bun:test";
import { frontmatterEditPlan } from "./frontmatterEdit";

// These tests cover the pure core, frontmatterEditPlan, and nothing else.
// editFrontmatter is the thin view wrapper: one dispatch that applies the
// plan and scrolls the caret into view. It goes untested, per the
// pure-core/DOM-wrapper split (testing.md §2).
describe("frontmatterEditPlan", () => {
  test("no block: opens one at the top, caret on the empty body line", () => {
    expect(frontmatterEditPlan("# Title\n\nbody\n")).toEqual({
      insert: { at: 0, text: "---\n\n---\n" },
      caret: 4,
    });
  });

  test("an empty note gets the same block", () => {
    expect(frontmatterEditPlan("")).toEqual({
      insert: { at: 0, text: "---\n\n---\n" },
      caret: 4,
    });
  });

  test("an unterminated opener is content (an hr), so a real block goes above it", () => {
    // shared/frontmatter.ts's rule: no closing fence, no block.
    expect(frontmatterEditPlan("---\n# Title\n")).toEqual({
      insert: { at: 0, text: "---\n\n---\n" },
      caret: 4,
    });
  });

  test("an empty block gets a body line to land on", () => {
    expect(frontmatterEditPlan("---\n---\n# Title\n")).toEqual({
      insert: { at: 4, text: "\n" },
      caret: 4,
    });
  });

  test("a block with a body: caret at the end of its last line, no edit", () => {
    expect(frontmatterEditPlan("---\ncwd: /x\ntags: a\n---\n# Title\n")).toEqual({
      insert: null,
      caret: 19,
    });
  });

  test("a closing fence with no trailing newline still lands inside", () => {
    expect(frontmatterEditPlan("---\ncwd: /x\n---")).toEqual({
      insert: null,
      caret: 11,
    });
  });
});
