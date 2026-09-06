import { describe, expect, test } from "bun:test";
import { formatArg, formatLine } from "./log";

const AT = new Date("2026-07-27T18:30:00.000Z");

describe("formatArg", () => {
  test("a string is itself", () => {
    expect(formatArg("shell exited")).toBe("shell exited");
  });

  // formatArg unwraps an Error to its stack. That is why it exists rather
  // than a plain `String(arg)`: `String(err)` keeps only the name and the
  // message. Nobody watches this output live (log.ts), so the log file is
  // the only record of a crash, and the stack is the part worth having.
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

  // JSON.stringify throws on a cycle. formatArg catches that and falls back
  // to String(arg). The argument it cannot serialize is the one the log call
  // is reporting on, so throwing here would lose the diagnostic along with
  // the entry.
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

  // formatLine keeps the newlines inside an argument rather than folding the
  // entry onto one line. Re-wrapping a stack that way would make it
  // unreadable. Nothing parses the log file: a person reads it.
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
