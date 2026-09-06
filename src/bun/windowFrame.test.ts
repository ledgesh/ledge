import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FRAME,
  MIN_HEIGHT,
  MIN_WIDTH,
  fitFrame,
  parseFrame,
  parseWindows,
  roundFrame,
  type Rect,
} from "./windowFrame";

// One 1512x945 laptop screen, menu bar already subtracted, origin at 0,0.
const LAPTOP: Rect = { x: 0, y: 0, width: 1512, height: 945 };
// A second display parked to the right, as macOS reports it: positive x beyond
// the primary's width.
const EXTERNAL: Rect = { x: 1512, y: 0, width: 2560, height: 1415 };

describe("parseFrame", () => {
  test("a well-formed frame round-trips", () => {
    expect(parseFrame('{"x":10,"y":20,"width":900,"height":600}')).toEqual({
      x: 10,
      y: 20,
      width: 900,
      height: 600,
    });
  });

  test("nothing saved yet is null, not an error", () => {
    expect(parseFrame(null)).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  // A truncated write and a hand-edited file both land here. No partial frame
  // escapes: a missing y with a present width would restore a window with a
  // NaN coordinate, which macOS accepts and then hides.
  test("anything short of four finite numbers is null", () => {
    expect(parseFrame("{")).toBeNull();
    expect(parseFrame("[1,2,3,4]")).toBeNull();
    expect(parseFrame("null")).toBeNull();
    expect(parseFrame('{"x":10,"y":20,"width":900}')).toBeNull();
    expect(parseFrame('{"x":10,"y":null,"width":900,"height":600}')).toBeNull();
    expect(parseFrame('{"x":"10","y":20,"width":900,"height":600}')).toBeNull();
  });

  test("a zero or negative size is refused, not clamped later", () => {
    expect(parseFrame('{"x":0,"y":0,"width":0,"height":600}')).toBeNull();
    expect(parseFrame('{"x":0,"y":0,"width":900,"height":-1}')).toBeNull();
  });
});

// The window list is read at boot so a launch reopens the windows that were
// open, each on the connection it was pointed at (remote.md §8a). Each failure
// below costs geometry or a connection. None of them may throw: readWindows
// runs before any window exists (index.ts).
describe("parseWindows", () => {
  const FRAME: Rect = { x: 10, y: 20, width: 900, height: 700 };

  test("windows come back in order, with their connections", () => {
    const text = JSON.stringify({
      version: 2,
      windows: [
        { ...FRAME, connection: "local" },
        { ...FRAME, x: 40, connection: "vps-1" },
      ],
    });
    expect(parseWindows(text, "local")).toEqual([
      { frame: FRAME, connection: "local" },
      { frame: { ...FRAME, x: 40 }, connection: "vps-1" },
    ]);
  });

  test("nothing saved yet is no windows, not an error", () => {
    expect(parseWindows(null, "local")).toEqual([]);
    expect(parseWindows("", "local")).toEqual([]);
    expect(parseWindows("{ half a wri", "local")).toEqual([]);
    expect(parseWindows("[1,2,3]", "local")).toEqual([]);
    expect(parseWindows('{"version":2}', "local")).toEqual([]);
  });

  // The file held one bare frame before there could be more than one window.
  // The only record of where that window was pointed is the stored selection.
  test("the single frame an older install saved becomes one window on the fallback", () => {
    expect(parseWindows(JSON.stringify(FRAME), "vps-1")).toEqual([{ frame: FRAME, connection: "vps-1" }]);
  });

  // One bad entry is skipped and the windows either side of it still open.
  // connections.json and the workspace registry drop unusable entries the same
  // way (connections.ts, workspaces.ts).
  test("an unusable entry is dropped and its neighbours survive", () => {
    const text = JSON.stringify({
      version: 2,
      windows: [{ ...FRAME, connection: "local" }, { x: 1, y: 2 }, null, "nope", { ...FRAME, connection: "vps-1" }],
    });
    expect(parseWindows(text, "local").map((w) => w.connection)).toEqual(["local", "vps-1"]);
  });

  test("an entry with no usable connection opens where a window with nothing to go on opens", () => {
    const text = JSON.stringify({ version: 2, windows: [FRAME, { ...FRAME, connection: 7 }, { ...FRAME, connection: "" }] });
    expect(parseWindows(text, "vps-1").map((w) => w.connection)).toEqual(["vps-1", "vps-1", "vps-1"]);
  });
});

describe("fitFrame", () => {
  test("no saved frame means the shipped default", () => {
    expect(fitFrame(null, [LAPTOP])).toEqual(DEFAULT_FRAME);
  });

  test("a frame that still fits its screen comes back untouched", () => {
    const saved: Rect = { x: 300, y: 200, width: 1000, height: 700 };
    expect(fitFrame(saved, [LAPTOP])).toEqual(saved);
  });

  test("a frame on a second display survives while that display is attached", () => {
    const saved: Rect = { x: 2000, y: 300, width: 1400, height: 900 };
    expect(fitFrame(saved, [LAPTOP, EXTERNAL])).toEqual(saved);
  });

  // An unplugged external monitor leaves the saved frame on no attached
  // display. Without fitFrame the window would open where no pointer can
  // reach it.
  test("a frame stranded by an unplugged display is re-centered, keeping its size", () => {
    const saved: Rect = { x: 2000, y: 300, width: 1400, height: 900 };
    const fit = fitFrame(saved, [LAPTOP]);
    expect({ width: fit.width, height: fit.height }).toEqual({ width: 1400, height: 900 });
    expect(fit.x).toBe(Math.round((LAPTOP.width - 1400) / 2));
    expect(fit.y).toBe(Math.round((LAPTOP.height - 900) / 2));
  });

  // The size the user chose is kept up to the size of the screen: fitFrame
  // clamps width and height to the display the frame best matches. Position
  // after a hardware change is not a choice the user made, so a frame with no
  // grabbable strip on any screen is re-centered instead.
  test("a window too big for the screen it lands on is shrunk to fit it", () => {
    const fit = fitFrame({ x: 2000, y: 100, width: 2400, height: 1300 }, [LAPTOP]);
    expect(fit.width).toBe(LAPTOP.width);
    expect(fit.height).toBe(LAPTOP.height);
  });

  test("a degenerate saved size is raised to the usable floor", () => {
    const fit = fitFrame({ x: 100, y: 100, width: 40, height: 30 }, [LAPTOP]);
    expect(fit.width).toBe(MIN_WIDTH);
    expect(fit.height).toBe(MIN_HEIGHT);
  });

  // This frame, dragged mostly off the bottom-right, still leaves a strip on
  // screen big enough to grab and drag back, so fitFrame honors it. GRAB_WIDTH
  // and GRAB_HEIGHT set the strip's size.
  test("a mostly-offscreen window is kept if enough of it is grabbable", () => {
    const saved: Rect = { x: LAPTOP.width - 400, y: LAPTOP.height - 200, width: 900, height: 700 };
    expect(fitFrame(saved, [LAPTOP])).toEqual(saved);
  });

  test("a sliver too thin to grab counts as stranded", () => {
    const saved: Rect = { x: LAPTOP.width - 30, y: 100, width: 900, height: 700 };
    const fit = fitFrame(saved, [LAPTOP]);
    expect(fit.x).not.toBe(saved.x);
  });

  // An empty work-area list means the native call failed. The saved frame is
  // the only evidence left, so fitFrame returns it unchanged rather than
  // centering the window on a guess.
  test("with no display information the saved frame is honored as-is", () => {
    const saved: Rect = { x: 9000, y: 9000, width: 900, height: 700 };
    expect(fitFrame(saved, [])).toEqual(saved);
  });

  test("every outcome is on some screen and at least the minimum size", () => {
    const cases: Rect[] = [
      { x: -5000, y: -5000, width: 900, height: 700 },
      { x: 9999, y: 9999, width: 100, height: 100 },
      { x: 0, y: 0, width: 99999, height: 99999 },
      { x: 1400, y: 900, width: 700, height: 500 },
    ];
    for (const saved of cases) {
      for (const screens of [[LAPTOP], [LAPTOP, EXTERNAL]]) {
        const fit = fitFrame(saved, screens);
        expect(fit.width).toBeGreaterThanOrEqual(MIN_WIDTH);
        expect(fit.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
        const reachable = screens.some(
          (s) =>
            Math.min(fit.x + fit.width, s.x + s.width) - Math.max(fit.x, s.x) >= 160 &&
            Math.min(fit.y + fit.height, s.y + s.height) - Math.max(fit.y, s.y) >= 44,
        );
        expect(reachable).toBe(true);
      }
    }
  });
});

// The frame arrives from the OS as doubles. Rounding keeps half-pixels out of
// the file, and the `text === lastWritten` check in writeWindows can still
// skip a redundant write.
test("roundFrame keeps the file in whole pixels", () => {
  expect(roundFrame({ x: 200.4, y: 119.6, width: 940.2, height: 700.5 })).toEqual({
    x: 200,
    y: 120,
    width: 940,
    height: 701,
  });
});
