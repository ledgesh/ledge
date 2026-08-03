import { describe, expect, test } from "bun:test";
import { escapeLeaves, isRunKey, liveRows, neededRows, RUN_KEYS, runKeyBytes } from "./inlineTerm";

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

describe("escapeLeaves", () => {
  test("a lone Escape stays with the program", () => {
    // Long since the last one: this is the first tap, and it belongs to
    // whatever is running (a shell's vi mode, an agent's interrupt).
    expect(escapeLeaves({ meta: false, pinned: false, sinceLastEscMs: 5000 })).toBe(false);
  });

  test("a second Escape soon after gives the keyboard back", () => {
    expect(escapeLeaves({ meta: false, pinned: false, sinceLastEscMs: 120 })).toBe(true);
  });

  test("two Escapes far apart are two lone Escapes", () => {
    expect(escapeLeaves({ meta: false, pinned: false, sinceLastEscMs: 900 })).toBe(false);
  });

  test("a full-screen program keeps both taps", () => {
    // vim's habitual double Escape must not eject the user from vim.
    expect(escapeLeaves({ meta: false, pinned: true, sinceLastEscMs: 80 })).toBe(false);
  });

  test("⌘Escape always leaves, full-screen program or not", () => {
    // The one form no program can claim, so it is the exit that always exists.
    expect(escapeLeaves({ meta: true, pinned: true, sinceLastEscMs: 5000 })).toBe(true);
    expect(escapeLeaves({ meta: true, pinned: false, sinceLastEscMs: 5000 })).toBe(true);
  });
});

describe("runKeyBytes", () => {
  test("the three the software keyboard has no key for", () => {
    expect(runKeyBytes("ctrlC", false)).toBe("\x03");
    expect(runKeyBytes("ctrlD", false)).toBe("\x04");
    expect(runKeyBytes("escape", false)).toBe("\x1b");
  });

  test("arrows in the ordinary mode", () => {
    expect(runKeyBytes("up", false)).toBe("\x1b[A");
    expect(runKeyBytes("down", false)).toBe("\x1b[B");
    expect(runKeyBytes("right", false)).toBe("\x1b[C");
    expect(runKeyBytes("left", false)).toBe("\x1b[D");
  });

  // DECCKM, which every full-screen program turns on: sending the other form
  // is an arrow that does nothing, in the one place arrows are the interface.
  test("arrows while a program owns the screen", () => {
    expect(runKeyBytes("up", true)).toBe("\x1bOA");
    expect(runKeyBytes("down", true)).toBe("\x1bOB");
    expect(runKeyBytes("right", true)).toBe("\x1bOC");
    expect(runKeyBytes("left", true)).toBe("\x1bOD");
  });

  // The mode is a fact about the cursor keys and nothing else.
  test("the mode leaves the others alone", () => {
    expect(runKeyBytes("ctrlC", true)).toBe("\x03");
    expect(runKeyBytes("escape", true)).toBe("\x1b");
  });

  test("leave sends nothing: it is the way out, not a keystroke", () => {
    expect(runKeyBytes("leave", false)).toBe("");
    expect(runKeyBytes("leave", true)).toBe("");
  });

  // The bar's tap arrives as a bare string, so an id the page does not know
  // has to be a refusal rather than bytes nobody chose.
  test("the vocabulary is closed", () => {
    for (const key of RUN_KEYS) expect(isRunKey(key)).toBe(true);
    expect(isRunKey("ctrlZ")).toBe(false);
    expect(isRunKey("format.bold")).toBe(false);
    expect(isRunKey("")).toBe(false);
  });
});
