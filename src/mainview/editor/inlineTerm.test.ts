import { describe, expect, test } from "bun:test";
import { liveRows, neededRows } from "./inlineTerm";

describe("neededRows", () => {
  test("counts the cursor's blank line, so xterm never has to scroll to keep it", () => {
    // Three echoes: output on rows 0-2, cursor parked on row 3 by the last
    // newline. Asking for 3 would make xterm scroll line 1 into scrollback.
    expect(neededRows(3, 3)).toBe(4);
  });

  test("costs nothing when the output ends without a newline", () => {
    // Cursor still on the last line of output, so there is no blank row to keep.
    expect(neededRows(3, 2)).toBe(3);
  });

  test("a cursor left up inside the output does not shrink the grid", () => {
    // A program that moved the cursor home (a redraw, a spinner) must not cost
    // the output below it.
    expect(neededRows(10, 0)).toBe(10);
  });

  test("one line of output with a trailing newline is two rows", () => {
    expect(neededRows(1, 1)).toBe(2);
  });
});

describe("liveRows", () => {
  test("grows with the output instead of opening at full height", () => {
    expect(liveRows(1, 3, false)).toBe(3);
  });

  test("never shrinks a running grid", () => {
    // A program that cleared the screen: it is drawing into those rows, so the
    // panel must not collapse around what is on screen this instant.
    expect(liveRows(12, 1, false)).toBe(12);
  });

  test("stops growing at the cap, and the run scrolls from there", () => {
    expect(liveRows(20, 500, false)).toBe(24);
  });

  test("a full-screen program gets the whole grid whatever it has drawn", () => {
    expect(liveRows(2, 1, true)).toBe(24);
  });
});
