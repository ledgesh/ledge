import { describe, expect, test } from "bun:test";
import { formatArg, formatLine } from "./log";

const AT = new Date("2026-07-27T18:30:00.000Z");

describe("formatArg", () => {
  test("a string is itself", () => {
    expect(formatArg("shell exited")).toBe("shell exited");
  });

  // The whole reason this function exists rather than String(): a log written
  // for a crash nobody watched needs the stack, and String(err) drops it.
  test("an Error keeps its stack", () => {
    const err = new Error("boom");
    expect(formatArg(err)).toContain("Error: boom");
    expect(formatArg(err)).toContain("log.test.ts");
  });

  test("an Error with no stack still names itself", () => {
    const err = new Error("boom");
    err.stack = undefined;
    expect(formatArg(err)).toBe("Error: boom");
  });

  test("an object is JSON, because a log full of [object Object] says nothing", () => {
    expect(formatArg({ root: "/ws", ok: false })).toBe('{"root":"/ws","ok":false}');
  });

  // Serializing must never be what takes the log entry down: the arg that
  // cannot be described is exactly the one being complained about.
  test("a cyclic object degrades instead of throwing", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => formatArg(cyclic)).not.toThrow();
  });

  test("undefined is spelled, not dropped", () => {
    expect(formatArg(undefined)).toBe("undefined");
    expect(formatLine(AT, "bun", "warn", [undefined])).toContain("undefined");
  });
});

describe("formatLine", () => {
  test("a line carries the time, the side that wrote it, and the level", () => {
    expect(formatLine(AT, "bun", "warn", ["[pty] no native trampolines"])).toBe(
      "2026-07-27T18:30:00.000Z [bun/warn] [pty] no native trampolines\n",
    );
  });

  test("the source distinguishes a view failure from a Bun one", () => {
    expect(formatLine(AT, "view", "error", ["render failed"])).toContain("[view/error]");
  });

  test("console's several arguments become one entry", () => {
    expect(formatLine(AT, "bun", "info", ["[notes] purged", 3, "note(s)"])).toBe(
      "2026-07-27T18:30:00.000Z [bun/info] [notes] purged 3 note(s)\n",
    );
  });

  // A stack is the payload, and re-wrapping it to keep one entry on one line
  // would only make it unreadable. Nothing parses this file.
  test("a multi-line stack is written through, not flattened", () => {
    const line = formatLine(AT, "bun", "error", ["failed", new Error("boom")]);
    expect(line.split("\n").length).toBeGreaterThan(2);
    expect(line.endsWith("\n")).toBe(true);
  });

  test("every entry ends with exactly one newline, so entries cannot run together", () => {
    const line = formatLine(AT, "bun", "info", ["done"]);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.endsWith("\n\n")).toBe(false);
  });
});
