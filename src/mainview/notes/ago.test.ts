import { describe, expect, test } from "bun:test";
import { agoLabel } from "./ago";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A fixed "now" rather than Date.now(): the boundaries below are the whole point
// of the test, and a real clock would make them flaky.
const NOW = 1_700_000_000_000;
const ago = (delta: number) => agoLabel(NOW - delta, NOW);

describe("agoLabel", () => {
  test("anything under a minute is just now", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59 * SEC)).toBe("just now");
  });

  test("minutes, hours, days", () => {
    expect(ago(MIN)).toBe("1m ago");
    expect(ago(59 * MIN)).toBe("59m ago");
    expect(ago(HOUR)).toBe("1h ago");
    expect(ago(23 * HOUR)).toBe("23h ago");
    expect(ago(DAY)).toBe("1d ago");
    expect(ago(29 * DAY)).toBe("29d ago");
  });

  test("rounds down, never up", () => {
    // 23h59m is not yet a day. Rounding up here would show a note as older than
    // it is, against a 30-day eviction that is counting the real number.
    expect(ago(DAY - MIN)).toBe("23h ago");
    expect(ago(HOUR - SEC)).toBe("59m ago");
    expect(ago(1.9 * DAY)).toBe("1d ago");
  });

  test("a timestamp in the future does not render as negative", () => {
    // Clock skew, or a file copied from a machine running ahead.
    expect(agoLabel(NOW + HOUR, NOW)).toBe("just now");
  });
});
