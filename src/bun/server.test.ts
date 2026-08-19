// What a client's held run output does when there is more of it than the cap
// (server.ts holdRunEvent, remote.md §7).
//
// The trimming rule is the whole of the pure logic: which events a full buffer
// gives up, and which it must not. The wiring around it — when a gap starts,
// when it is released — is over a real socket in daemon.fs.test.ts.
import { describe, expect, test } from "bun:test";
import { holdRunEvent, type HeldRuns } from "./server";
import type { InlineEvent } from "./inlinePool";

const empty = (): HeldRuns => ({ events: [], bytes: 0 });
const out = (blockId: string, text: string): InlineEvent => ({
  type: "output",
  blockId,
  data: new TextEncoder().encode(text),
});
const said = (held: HeldRuns) =>
  held.events
    .filter((e) => e.type === "output")
    .map((e) => new TextDecoder().decode((e as { data: Uint8Array }).data))
    .join("");

describe("holding a run's output for a client that is not there", () => {
  test("everything under the cap is kept, in the order the shell said it", () => {
    const held = empty();
    holdRunEvent(held, { type: "began", blockId: "r1" }, 1024);
    holdRunEvent(held, out("r1", "one "), 1024);
    holdRunEvent(held, out("r1", "two"), 1024);
    holdRunEvent(held, { type: "ended", blockId: "r1", exitCode: 0 }, 1024);

    expect(held.events.map((e) => e.type)).toEqual(["began", "output", "output", "ended"]);
    expect(said(held)).toBe("one two");
    expect(held.bytes).toBe(7);
  });

  // One order across every run, because two runs interleaving is a fact about
  // what happened: a queue per run would replay them as two blocks.
  test("two runs share one order", () => {
    const held = empty();
    holdRunEvent(held, out("r1", "a"), 1024);
    holdRunEvent(held, out("r2", "b"), 1024);
    holdRunEvent(held, out("r1", "c"), 1024);

    expect(held.events.map((e) => (e.type === "output" ? e.blockId : e.type))).toEqual(["r1", "r2", "r1"]);
  });

  // The tail, like the drawer's scrollback: what a panel needs to make sense of
  // is where the build got to, not where it started.
  test("past the cap the oldest output goes", () => {
    const held = empty();
    holdRunEvent(held, out("r1", "aaaa"), 6);
    holdRunEvent(held, out("r1", "bbbb"), 6);

    expect(said(held)).toBe("bbbb");
    expect(held.bytes).toBe(4);
  });

  // The invariant the cap must not break. A panel whose `ended` was trimmed
  // sits on "Running" for good with its block's Run button dead behind it,
  // which is the failure the hold exists to prevent — so a full buffer gives up
  // text and never state.
  test("the markers survive a buffer that overflowed many times over", () => {
    const held = empty();
    holdRunEvent(held, { type: "began", blockId: "r1" }, 8);
    for (let i = 0; i < 50; i++) holdRunEvent(held, out("r1", "0123456789"), 8);
    holdRunEvent(held, { type: "ended", blockId: "r1", exitCode: 3 }, 8);

    expect(held.events[0]).toEqual({ type: "began", blockId: "r1" });
    expect(held.events[held.events.length - 1]).toEqual({ type: "ended", blockId: "r1", exitCode: 3 });
    // One chunk over, since trimming stops at the first event that brings the
    // total under: a 10-byte chunk cannot be split to fit an 8-byte cap, and
    // dropping it as well would leave the panel with nothing at all.
    expect(said(held)).toBe("0123456789");
  });

  // A cap cannot act on what a cap cannot drop, and a buffer of nothing but
  // markers must terminate rather than spin looking for output to remove.
  test("a buffer with no output in it is left alone", () => {
    const held = empty();
    holdRunEvent(held, { type: "began", blockId: "r1" }, 0);
    holdRunEvent(held, { type: "ended", blockId: "r1", exitCode: 0 }, 0);

    expect(held.events).toHaveLength(2);
    expect(held.bytes).toBe(0);
  });
});
