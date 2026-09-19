import { describe, expect, test } from "bun:test";
import { scrollerToTop } from "./scrollToTop";

describe("which scroller a status-bar tap scrolls", () => {
  test("the outermost one that is off its top", () => {
    // A run's output (inner) inside a note (outer), both scrolled.
    const chain = [
      { scrolls: true, scrollTop: 40 },
      { scrolls: false, scrollTop: 0 },
      { scrolls: true, scrollTop: 900 },
      { scrolls: false, scrollTop: 0 },
    ];
    expect(scrollerToTop(chain)).toBe(2);
  });

  test("an inner one when the outer is already at its top", () => {
    const chain = [
      { scrolls: true, scrollTop: 40 },
      { scrolls: true, scrollTop: 0 },
    ];
    expect(scrollerToTop(chain)).toBe(0);
  });

  test("nothing when everything is at the top, or nothing scrolls", () => {
    expect(scrollerToTop([{ scrolls: true, scrollTop: 0 }])).toBe(-1);
    // A clipped element holding a stale offset is not a scroller.
    expect(scrollerToTop([{ scrolls: false, scrollTop: 30 }])).toBe(-1);
    expect(scrollerToTop([])).toBe(-1);
  });
});
