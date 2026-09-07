import { describe, expect, test } from "bun:test";
import { escapeLeaves, isRunKey, liveRows, neededRows, RUN_KEYS, runKeyBytes } from "./inlineTerm";

describe("neededRows", () => {
  test("counts the cursor's blank line, so xterm never has to scroll to keep it", () => {
    // Three echoes put output on rows 0 to 2. The last newline leaves the
    // cursor on row 3. Asking xterm for 3 rows would scroll line 1 into
    // scrollback instead of dropping the blank row.
    expect(neededRows(3, 3)).toBe(4);
  });

  test("costs nothing when the output ends without a newline", () => {
    // Cursor still on the last line of output, so there is no blank row to keep.
    expect(neededRows(3, 2)).toBe(3);
  });

  test("a cursor left up inside the output does not shrink the grid", () => {
    // A redraw or a spinner moves the cursor back to the top. The output
    // below it still counts, so the row count stays 10.
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
    // A program that cleared the screen is still drawing into those rows. The
    // grid keeps its current height rather than shrinking to what is on
    // screen right now.
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
    // The last Escape was long ago (past ESC_EXIT_MS), so this counts as a
    // first tap and goes to the running program: a shell's vi mode, an
    // agent's interrupt.
    expect(escapeLeaves({ meta: false, pinned: false, sinceLastEscMs: 5000 })).toBe(false);
  });

  test("a second Escape soon after gives the keyboard back", () => {
    expect(escapeLeaves({ meta: false, pinned: false, sinceLastEscMs: 120 })).toBe(true);
  });

  test("two Escapes far apart are two lone Escapes", () => {
    expect(escapeLeaves({ meta: false, pinned: false, sinceLastEscMs: 900 })).toBe(false);
  });

  test("a full-screen program keeps both taps", () => {
    // Pressing Escape twice is a habit in vim. Both taps stay with the
    // program instead of handing the keyboard back to the note.
    expect(escapeLeaves({ meta: false, pinned: true, sinceLastEscMs: 80 })).toBe(false);
  });

  test("⌘Escape always leaves, full-screen program or not", () => {
    // `meta` is checked before `pinned`, so ⌘Escape leaves either way. It is
    // also the one form a full-screen program cannot swallow, which is why it
    // is the exit while a program owns the screen.
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

  // The second argument is application cursor mode (DECCKM), which vim, less
  // and ncurses programs turn on while they own the screen. An arrow is
  // `ESC O A` there and `ESC [ A` everywhere else. The wrong form is an arrow
  // that does nothing, in the one place arrows are the whole interface.
  test("arrows while a program owns the screen", () => {
    expect(runKeyBytes("up", true)).toBe("\x1bOA");
    expect(runKeyBytes("down", true)).toBe("\x1bOB");
    expect(runKeyBytes("right", true)).toBe("\x1bOC");
    expect(runKeyBytes("left", true)).toBe("\x1bOD");
  });

  // DECCKM changes the cursor keys only. Ctrl-C and Escape send the same
  // bytes either way.
  test("the mode leaves the others alone", () => {
    expect(runKeyBytes("ctrlC", true)).toBe("\x03");
    expect(runKeyBytes("escape", true)).toBe("\x1b");
  });

  test("leave sends nothing: it is the way out, not a keystroke", () => {
    expect(runKeyBytes("leave", false)).toBe("");
    expect(runKeyBytes("leave", true)).toBe("");
  });

  // A tap on the accessory bar arrives as a bare string, so an id the page
  // does not know has to be a refusal. `sendRunKey` calls `isRunKey` and
  // returns false when it says no, rather than turning the name into bytes.
  test("the vocabulary is closed", () => {
    for (const key of RUN_KEYS) expect(isRunKey(key)).toBe(true);
    expect(isRunKey("ctrlZ")).toBe(false);
    expect(isRunKey("format.bold")).toBe(false);
    expect(isRunKey("")).toBe(false);
  });
});
