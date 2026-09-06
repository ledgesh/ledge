// holdRunEvent trims a client's held run output once it passes the cap
// (server.ts, remote.md §7). That trimming rule is the whole of the pure
// logic: which events a full buffer gives up, and which it must not. The
// wiring around it (when a gap starts, when it is released) is tested over a
// real socket in daemon.fs.test.ts.
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

  // One queue for all of a client's runs, not one per run. Two runs that
  // interleaved replay in the order the shell printed them. The interleaving
  // is a fact about what happened on the machine. A queue per run would
  // replay them as two blocks.
  test("two runs share one order", () => {
    const held = empty();
    holdRunEvent(held, out("r1", "a"), 1024);
    holdRunEvent(held, out("r2", "b"), 1024);
    holdRunEvent(held, out("r1", "c"), 1024);

    expect(held.events.map((e) => (e.type === "output" ? e.blockId : e.type))).toEqual(["r1", "r2", "r1"]);
  });

  // Trimming drops the oldest output and keeps the tail: a panel needs to show
  // where the run got to, not where it started. The loop is the same one the
  // drawer's scrollback ring runs (sbPush in server.ts), though the hold is
  // not that ring (remote.md §7).
  test("past the cap the oldest output goes", () => {
    const held = empty();
    holdRunEvent(held, out("r1", "aaaa"), 6);
    holdRunEvent(held, out("r1", "bbbb"), 6);

    expect(said(held)).toBe("bbbb");
    expect(held.bytes).toBe(4);
  });

  // The cap must never drop `began` or `ended`. A panel whose `ended` was
  // trimmed sits on "Running" for good, with its block's Run button disabled
  // behind it (remote.md §7). Preventing that is what the hold is for. A full
  // buffer gives up output and never markers.
  test("the markers survive a buffer that overflowed many times over", () => {
    const held = empty();
    holdRunEvent(held, { type: "began", blockId: "r1" }, 8);
    for (let i = 0; i < 50; i++) holdRunEvent(held, out("r1", "0123456789"), 8);
    holdRunEvent(held, { type: "ended", blockId: "r1", exitCode: 3 }, 8);

    expect(held.events[0]).toEqual({ type: "began", blockId: "r1" });
    expect(held.events[held.events.length - 1]).toEqual({ type: "ended", blockId: "r1", exitCode: 3 });
    // Trimming normally stops as soon as the total is back within the cap.
    // Here it stops at the last output event: a 10-byte chunk cannot be split
    // to fit an 8-byte cap. One chunk survives even though it is over the cap.
    // Dropping it would leave the panel with nothing at all.
    expect(said(held)).toBe("0123456789");
  });

  // holdRunEvent records every event, then returns before the byte accounting
  // for anything that is not output. So a marker is kept, adds no bytes, and
  // starts no trimming: a buffer holding nothing but markers is left alone
  // even at a cap of 0.
  test("a buffer with no output in it is left alone", () => {
    const held = empty();
    holdRunEvent(held, { type: "began", blockId: "r1" }, 0);
    holdRunEvent(held, { type: "ended", blockId: "r1", exitCode: 0 }, 0);

    expect(held.events).toHaveLength(2);
    expect(held.bytes).toBe(0);
  });
});
