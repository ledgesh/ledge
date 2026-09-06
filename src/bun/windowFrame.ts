// Which windows were open and where: `window.json` in the client home, one
// entry per window, each naming the connection it was pointed at.
// architecture.md §6 covers its ownership shape and why it sits in the client
// home rather than the app home; remote.md §8a covers why each window stores
// its own connection instead of sharing `connections.json`'s `selected` key.
//
// It is not a corner of `.layout.json`. That file's shape belongs to the view,
// and a Bun-authored key folded into it would put both ends in the same object
// with no owner. The app home's older `.window.json` is migrated across on
// first read rather than read in place.
//
// `fitFrame` checks a saved frame against the displays attached right now. A
// window restored onto a monitor that is no longer attached cannot be reached.
// That is worse than not persisting geometry at all. `fitFrame` is pure, so
// the geometry can be tested without a screen.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME } from "./workspaces";
import { CLIENT_HOME, ensureClientHomeSync } from "./clientHome";

export const WINDOW_PATH = join(CLIENT_HOME, "window.json");
// Where the file lived before the client home existed. `readWindows` renames
// it into place on the first read that finds nothing at `WINDOW_PATH`.
export const LEGACY_WINDOW_PATH = join(APP_HOME, ".window.json");

export type Rect = { x: number; y: number; width: number; height: number };

/** One window: the frame it had, and the connection it was pointed at. */
export interface WindowState {
  frame: Rect;
  /** A connection id, `LOCAL_ID` included. Nothing here checks it against the
   * connection list. A connection removed since the last quit falls back to the
   * local server at boot, with the reason on screen (connectionManager.ts). */
  connection: string;
}

// First launch, and the fallback whenever nothing better can be computed.
export const DEFAULT_FRAME: Rect = { x: 200, y: 120, width: 940, height: 700 };

// A floor, not a preference. Below roughly this size the sidebar, the editor,
// and the terminal drawer no longer fit together. macOS lets someone drag a
// window smaller than that, and reopening at that size looks like breakage.
// `fitFrame` raises a saved size to this floor whenever it has display
// information; with none it returns the saved frame untouched.
export const MIN_WIDTH = 640;
export const MIN_HEIGHT = 480;

// How much of a window has to fall on a screen for the frame to count as
// reachable: a strip of title bar wide enough to grab and drag back. `overlap`
// scores anything smaller as zero, and `fitFrame` then re-centers instead of
// restoring.
const GRAB_WIDTH = 160;
const GRAB_HEIGHT = 44;

// --- pure core (unit-tested in windowFrame.test.ts) --------------------------

// A frame from disk, or null for no usable frame: absent file, truncated
// write, hand-edited nonsense. Every failure means the same thing to the
// caller, so none of them are distinguished.
export function parseFrame(text: string | null): Rect | null {
  if (!text) return null;
  try {
    return frameOf(JSON.parse(text));
  } catch {
    return null;
  }
}

function frameOf(raw: unknown): Rect | null {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  const nums = [x, y, width, height];
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

/**
 * The window list from disk, in the order the windows should be reopened.
 *
 * Two formats are read and one is written. `{version, windows}` is current. A
 * bare frame is what the file held before there could be more than one window,
 * and it becomes a single window pointed at `fallback`: callers pass the stored
 * selection there (connectionStore.ts `launchSelection`), the only record an
 * upgrading install has of where it was. Anything unreadable returns an empty
 * list. The caller turns that into one window on the fallback, so a client that
 * cannot read its window list still gets a window.
 */
export function parseWindows(text: string | null, fallback: string): WindowState[] {
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const legacy = frameOf(raw);
  if (legacy) return [{ frame: legacy, connection: fallback }];
  const list = (raw as Record<string, unknown>)["windows"];
  if (!Array.isArray(list)) return [];
  const windows: WindowState[] = [];
  for (const entry of list) {
    const frame = frameOf(entry);
    if (!frame) continue;
    const connection = (entry as Record<string, unknown>)["connection"];
    windows.push({ frame, connection: typeof connection === "string" && connection ? connection : fallback });
  }
  return windows;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w >= GRAB_WIDTH && h >= GRAB_HEIGHT ? w * h : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

// Reconciles a saved frame with the screens attached right now.
//
// `workAreas` are the displays' usable rectangles (menu bar and Dock already
// subtracted), primary first. Only the caller can ask the OS which display is
// primary, so the caller orders them. Both rectangles are top-left-origin in
// one global space, so overlapping them is meaningful: index.ts establishes
// that about Electrobun's API where the two meet.
//
// A stranded frame (unplugged monitor, a display that shrank) keeps its size
// and is re-centered on the display it best matches. The size is a choice the
// user made; the position after a hardware change is not.
export function fitFrame(saved: Rect | null, workAreas: Rect[]): Rect {
  if (!saved) return { ...DEFAULT_FRAME };
  // No display info at all (the native call failed). The saved frame is the
  // only evidence left, so it stands rather than moving the window on a guess.
  if (workAreas.length === 0) return { ...saved };

  let best = workAreas[0]!;
  let bestArea = 0;
  for (const area of workAreas) {
    const a = overlap(saved, area);
    if (a > bestArea) {
      bestArea = a;
      best = area;
    }
  }
  const width = clamp(saved.width, MIN_WIDTH, Math.max(MIN_WIDTH, best.width));
  const height = clamp(saved.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, best.height));
  // Score the overlap again, because a clamp that shrank the rectangle can
  // pull it off the screen its saved size was hanging onto.
  const sized = { x: saved.x, y: saved.y, width, height };
  if (bestArea > 0 && overlap(sized, best) > 0) return sized;
  return {
    x: Math.round(best.x + (best.width - width) / 2),
    y: Math.round(best.y + (best.height - height) / 2),
    width,
    height,
  };
}

export function roundFrame(frame: Rect): Rect {
  return {
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    width: Math.round(frame.width),
    height: Math.round(frame.height),
  };
}

// --- the file ----------------------------------------------------------------
// This file is read and written synchronously, unlike the layout file
// (layout.ts uses promises). The read happens once before any window exists,
// so nothing else is in flight. The write has to be callable from
// `process.on("exit")` in index.ts, where a promise never resolves.

export function readWindows(fallback: string): WindowState[] {
  try {
    return parseWindows(readFileSync(WINDOW_PATH, "utf8"), fallback);
  } catch {
    // Nothing there: an install that predates the client home may still have
    // the old file. Rename it rather than copy it, so only one file ever holds
    // the window list. A failure here returns the empty list instead of
    // throwing, since a lost frame costs one launch its geometry.
    try {
      ensureClientHomeSync();
      renameSync(LEGACY_WINDOW_PATH, WINDOW_PATH);
      return parseWindows(readFileSync(WINDOW_PATH, "utf8"), fallback);
    } catch {
      return [];
    }
  }
}

let lastWritten = "";

// Writes the window list, best effort. A failed save costs the next launch its
// windows. That is not worth a dialog or a crash, so this warns and returns.
// The write is temp-plus-rename anyway: `parseWindows` would discard a
// half-written file, but leaving one on disk invites a later reader to trust
// it.
export function writeWindows(windows: readonly WindowState[]): void {
  const text = JSON.stringify({
    version: 2,
    windows: windows.map((w) => ({ ...roundFrame(w.frame), connection: w.connection })),
  });
  if (text === lastWritten) return;
  try {
    ensureClientHomeSync();
    const tmp = `${WINDOW_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, WINDOW_PATH);
    lastWritten = text;
  } catch (err) {
    console.warn(`[window] could not save the window list (${err})`);
  }
}
