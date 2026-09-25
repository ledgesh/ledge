// How long an ending run took (blocks.ts endedDuration). The client may hear of
// an ending long after it happened: a phone in the background or a Mac with its
// lid shut gets the ending from the server's hold on reconnect (remote.md §7),
// so the client's own clock would count the outage.
import { describe, expect, test } from "bun:test";
import { endedDuration } from "./blocks";

const STARTED = 1_000_000;
// The run lasted 15 s and the client came back 45 s after it ended.
const HEARD = STARTED + 60_000;

describe("endedDuration", () => {
  test("the server's length wins over this client's clock", () => {
    expect(endedDuration(STARTED, 15_000, HEARD)).toBe(15_000);
  });

  test("an ending with no known length shows none", () => {
    // reconcileRuns closing out a run whose ending was lost (bridge.ts).
    expect(endedDuration(STARTED, null, HEARD)).toBeNull();
  });

  test("a server older than the field is timed on this client's clock", () => {
    expect(endedDuration(STARTED, undefined, HEARD)).toBe(60_000);
  });

  test("a run with no start time has no length to time", () => {
    expect(endedDuration(0, undefined, HEARD)).toBeNull();
  });
});
