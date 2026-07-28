import { describe, expect, test } from "bun:test";
import { bracketedPaste, plainPaste, QUIET_MS, takePaste, type PasteShell } from "./paste";

function shell(over: Partial<PasteShell> = {}): PasteShell {
  return { promptReady: false, everReady: false, pasteQueue: [], lastOut: 0, ...over };
}

describe("paste formats", () => {
  test("bracketed paste carries the markers and submits", () => {
    expect(bracketedPaste("ls -la")).toBe("\x1b[200~ls -la\x1b[201~\r");
  });

  test("plain paste is the text and Enter, no markers", () => {
    expect(plainPaste("ls -la")).toBe("ls -la\r");
  });

  test("both trim trailing newlines, which would be extra blank lines", () => {
    expect(bracketedPaste("echo hi\n\n")).toBe("\x1b[200~echo hi\x1b[201~\r");
    expect(plainPaste("echo hi\n\n")).toBe("echo hi\r");
    // Newlines INSIDE a multi-line block are the block; only the tail goes.
    expect(plainPaste("a\nb\n")).toBe("a\nb\r");
  });
});

describe("takePaste at a prompt", () => {
  test("releases bracketed and consumes the prompt", () => {
    const t = shell({ promptReady: true, everReady: true, pasteQueue: ["one", "two"] });
    expect(takePaste(t, 1000)).toBe(bracketedPaste("one"));
    expect(t.promptReady).toBe(false);
    expect(t.pasteQueue).toEqual(["two"]);
  });

  test("one command per prompt: the next call waits for the next one", () => {
    const t = shell({ promptReady: true, everReady: true, pasteQueue: ["one", "two"] });
    takePaste(t, 1000);
    expect(takePaste(t, 1000)).toBeNull();
    t.promptReady = true; // the shell printed another prompt
    expect(takePaste(t, 1100)).toBe(bracketedPaste("two"));
  });

  test("an empty queue releases nothing and leaves the prompt alone", () => {
    const t = shell({ promptReady: true, everReady: true });
    expect(takePaste(t, 1000)).toBeNull();
    expect(t.promptReady).toBe(true);
  });

  test("a busy shell holds the queue however long it runs", () => {
    // everReady: this shell HAS a bracketed-paste mode, so silence means a job
    // is running, not a shell that cannot say so. The quiet rule must not fire.
    const t = shell({ everReady: true, pasteQueue: ["deploy"], lastOut: 1000 });
    expect(takePaste(t, 1000 + QUIET_MS * 100)).toBeNull();
    expect(t.pasteQueue).toEqual(["deploy"]);
  });
});

describe("takePaste on a shell with no bracketed-paste mode", () => {
  test("releases plain once the shell has been quiet", () => {
    const t = shell({ pasteQueue: ["echo hi"], lastOut: 1000 });
    expect(takePaste(t, 1000 + QUIET_MS - 1)).toBeNull();
    expect(takePaste(t, 1000 + QUIET_MS)).toBe(plainPaste("echo hi"));
  });

  test("waits for the shell to say anything at all first", () => {
    // lastOut 0 is a shell that has not printed its banner or prompt yet.
    // "Quiet" is only meaningful after something has been heard.
    const t = shell({ pasteQueue: ["echo hi"], lastOut: 0 });
    expect(takePaste(t, 10_000_000)).toBeNull();
  });

  test("a banner still arriving keeps pushing the release out", () => {
    const t = shell({ pasteQueue: ["echo hi"], lastOut: 1000 });
    expect(takePaste(t, 1300)).toBeNull();
    t.lastOut = 1300; // more banner
    expect(takePaste(t, 1600)).toBeNull();
    t.lastOut = 1600;
    expect(takePaste(t, 2000)).toBe(plainPaste("echo hi"));
  });

  test("the second paste waits out its own quiet period, not the first one's", () => {
    // The release stamps lastOut itself. Without that, both pastes would go on
    // the same tick — the echo of the first has not come back yet — and the
    // second would land inside the first command's run.
    const t = shell({ pasteQueue: ["one", "two"], lastOut: 1000 });
    expect(takePaste(t, 1500)).toBe(plainPaste("one"));
    expect(takePaste(t, 1500)).toBeNull();
    expect(takePaste(t, 1500 + QUIET_MS)).toBe(plainPaste("two"));
  });

  test("a prompt seen later takes over from the fallback", () => {
    // Some shells only enable the mode once their rc files have run; the real
    // signal must win as soon as it exists.
    const t = shell({ pasteQueue: ["one"], lastOut: 1000, promptReady: true, everReady: true });
    expect(takePaste(t, 1000)).toBe(bracketedPaste("one"));
  });
});
