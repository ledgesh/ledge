import { describe, expect, test } from "bun:test";
import { configureLog, describeError, logFailure } from "./log";

describe("describeError", () => {
  // The stack is the reason any of this exists: a forwarded line without one
  // says that something somewhere threw, which nobody can act on.
  test("an Error keeps its stack", () => {
    const err = new Error("render failed");
    expect(describeError(err, "?")).toContain("Error: render failed");
    expect(describeError(err, "?")).toContain("log.test.ts");
  });

  // The view runs in JavaScriptCore, which — unlike the V8-shaped stacks
  // `bun test` produces — leaves the message OUT of `stack`. A live probe
  // caught this as forwarded lines that were a minified file:line and nothing
  // else; this pins the fix against a stack shaped the way WebKit shapes one.
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

  // window.onerror fires with a null error for cross-origin script failures;
  // the fallback is the message-and-position the event carries instead.
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

// The only test that touches the module's per-session counter, so it owns it.
describe("the session budget", () => {
  test("an erroring render loop is cut off, and the log says it was", () => {
    const sent: string[] = [];
    configureLog({ append: (_level, text) => sent.push(text), reveal: () => {} });
    for (let i = 0; i < 500; i += 1) logFailure("error", `failure ${i}`);
    // The head is kept, not the tail: the first failures are the ones that
    // explain the rest.
    expect(sent[0]).toBe("failure 0");
    expect(sent.length).toBeLessThan(500);
    // Silence would read as "nothing more went wrong", which is the opposite
    // of what happened.
    expect(sent[sent.length - 1]).toContain("suppressed");
  });
});
