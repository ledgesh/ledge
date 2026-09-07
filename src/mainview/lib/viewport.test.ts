import { describe, expect, test } from "bun:test";
import { isSinglePane, PANES_MIN_WIDTH } from "./viewport";

// `isSinglePane` is a comparison against `PANES_MIN_WIDTH`, so it is tested
// here. `useSinglePane` needs a window, so the e2e suite has it instead.
// phone.spec.ts asserts the arrangement at 390 points, then resizes to 1200
// to assert the wide branch. The desktop project gets that branch for free at
// its own width.
describe("one pane or several", () => {
  test("a phone is one pane, in either orientation", () => {
    expect(isSinglePane(390)).toBe(true); // iPhone 14 portrait
    expect(isSinglePane(440)).toBe(true); // iPhone 16 Pro Max portrait
    // A phone in landscape is wider than the breakpoint and keeps its panes.
    // 844 points is a small desktop window rather than a phone shape, and the
    // sidebar fits in it.
    expect(isSinglePane(844)).toBe(false);
  });

  test("an iPad in portrait keeps its panes", () => {
    // An iPad in portrait is 744 points, above the 640 breakpoint, so it
    // keeps its panes. ios.md §9 wants that: §7 treats an iPad with a
    // hardware keyboard as a Mac-shaped client, whose existing keymap is
    // already right for it.
    expect(isSinglePane(744)).toBe(false); // iPad mini
    expect(isSinglePane(768)).toBe(false); // iPad
    expect(isSinglePane(1024)).toBe(false);
  });

  test("the boundary belongs to the wider side", () => {
    expect(isSinglePane(PANES_MIN_WIDTH - 1)).toBe(true);
    expect(isSinglePane(PANES_MIN_WIDTH)).toBe(false);
  });

  test("a window narrowed past the breakpoint switches, not only a phone", () => {
    // The breakpoint is on width alone, so a Mac window dragged narrow gets
    // this branch too. ios.md §9 asks for that: below 640 the sidebar's
    // 180-point floor (App.tsx SIDEBAR_MIN) leaves little of the editor, on a
    // Mac as much as on a phone.
    expect(isSinglePane(500)).toBe(true);
  });
});
