import { describe, expect, test } from "bun:test";
import { isSinglePane, PANES_MIN_WIDTH } from "./viewport";

// The hook half needs a window and belongs to the e2e suite (phone.spec.ts
// asserts the arrangement at 390 and the desktop suite gets the other branch
// for free). This is the decision itself, which is arithmetic.
describe("one pane or several", () => {
  test("a phone is one pane, in either orientation", () => {
    expect(isSinglePane(390)).toBe(true); // iPhone 14 portrait
    expect(isSinglePane(440)).toBe(true); // iPhone 16 Pro Max portrait
    // Landscape on a phone is wider than the breakpoint and still gets panes,
    // which is the intent: 844 points is a small desktop window, not a phone
    // shape, and the sidebar fits in it.
    expect(isSinglePane(844)).toBe(false);
  });

  test("an iPad in portrait keeps its panes", () => {
    // ios.md §7: an iPad with a hardware keyboard is a Mac-shaped client and
    // the existing arrangement is already right for it.
    expect(isSinglePane(744)).toBe(false); // iPad mini
    expect(isSinglePane(768)).toBe(false); // iPad
    expect(isSinglePane(1024)).toBe(false);
  });

  test("the boundary belongs to the wider side", () => {
    expect(isSinglePane(PANES_MIN_WIDTH - 1)).toBe(true);
    expect(isSinglePane(PANES_MIN_WIDTH)).toBe(false);
  });

  test("a window narrowed past the breakpoint switches, not only a phone", () => {
    // The media query is on width alone, so this is reachable on a Mac and is
    // meant to be: below 640 the sidebar's 180-point floor has eaten most of
    // the editor either way.
    expect(isSinglePane(500)).toBe(true);
  });
});
