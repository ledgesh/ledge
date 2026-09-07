import { describe, expect, test } from "bun:test";
import { configureLog, describeError, logFailure } from "./log";

describe("describeError", () => {
  // The stack is what makes a forwarded line worth reading. Without it the
  // line says only that something somewhere threw.
  test("an Error keeps its stack", () => {
    const err = new Error("render failed");
    expect(describeError(err, "?")).toContain("Error: render failed");
    expect(describeError(err, "?")).toContain("log.test.ts");
  });

  // The view runs in JavaScriptCore, which leaves the message out of `stack`.
  // `bun test` produces V8-shaped stacks that carry the message. This test
  // sets a WebKit-shaped stack by hand. A live probe surfaced this: forwarded
  // lines that were a minified file:line and nothing else.
  test("a WebKit-shaped stack still leads with the message", () => {
    const err = new Error("render failed");
    err.stack = "@views://mainview/assets/index-BhqPzFdB.js:565:10428";
    expect(describeError(err, "?")).toBe(
      "Error: render failed\n@views://mainview/assets/index-BhqPzFdB.js:565:10428",
    );
  });

  test("a message already in the stack is not repeated", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at x (y.js:1:1)";
    expect(describeError(err, "?")).toBe("Error: boom\n    at x (y.js:1:1)");
  });

  test("a thrown string is itself", () => {
    expect(describeError("nope", "?")).toBe("nope");
  });

  // A cross-origin script failure reaches the `error` listener with a null
  // `error`. captureFailures always passes a `fallback` (log.ts), and three
  // different ones: the message and position the event carries, "(no reason)"
  // for an unhandled rejection, `String(a)` for a console.error argument.
  test("nothing thrown falls back to what the event knew", () => {
    expect(describeError(null, "Script error. (views://x.js:1)")).toBe("Script error. (views://x.js:1)");
    expect(describeError(undefined, "fallback")).toBe("fallback");
    expect(describeError("   ", "fallback")).toBe("fallback");
  });

  test("a thrown object is described rather than reduced to [object Object]", () => {
    expect(describeError({ code: 42 }, "?")).toBe('{"code":42}');
  });

  test("a cyclic value degrades instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => describeError(cyclic, "?")).not.toThrow();
  });
});

// Only this block calls logFailure. The module's per-session line counter
// never resets, so a second block that logged failures would start with the
// budget already spent.
describe("the session budget", () => {
  test("an erroring render loop is cut off, and the log says it was", () => {
    const sent: string[] = [];
    configureLog({ append: (_level, text) => sent.push(text), reveal: () => {} });
    for (let i = 0; i < 500; i += 1) logFailure("error", `failure ${i}`);
    // The cap keeps the head, not the tail. The first failures explain the
    // cascade that follows them.
    expect(sent[0]).toBe("failure 0");
    expect(sent.length).toBeLessThan(500);
    // logFailure writes a last line saying the rest were suppressed.
    // Otherwise the silence would read as nothing more going wrong.
    expect(sent[sent.length - 1]).toContain("suppressed");
  });
});
