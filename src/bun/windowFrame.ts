// Where the window was last left: `window.json` in the client home, one frame.
// A fourth ownership shape alongside the three in architecture.md §6 —
// machine-written AND Bun-shaped like the registry, but not a trust artifact:
// the view never has an opinion about the window it lives in, so this file
// stays entirely on this side of the RPC and no schema entry exists for it.
//
// Its own file rather than a corner of `.layout.json` because that file's
// SHAPE is the view's; Bun only moves its bytes. Folding a Bun-authored key
// into it would put both ends in the same object with no owner.
//
// CLIENT-side, not server-side (remote.md §5): a window's position is a fact
// about the screen it is on, and a Mac connected to a VPS must not restore
// that VPS's idea of where windows go — which is also why the app home's older
// `.window.json` is migrated across on first read rather than read in place.
//
// A saved frame is not trusted as coordinates. Displays come and go, and a
// window restored onto a monitor that is no longer attached is a window the
// user cannot reach — strictly worse than not persisting at all. `fitFrame`
// is the gate, and it is pure so the geometry can be tested without a screen.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME } from "./workspaces";
import { CLIENT_HOME, ensureClientHomeSync } from "./clientHome";

export const WINDOW_PATH = join(CLIENT_HOME, "window.json");
// Where it lived before the client home existed. Read once, moved, forgotten.
export const LEGACY_WINDOW_PATH = join(APP_HOME, ".window.json");

export type Rect = { x: number; y: number; width: number; height: number };

// First launch, and the fallback whenever nothing better can be computed.
export const DEFAULT_FRAME: Rect = { x: 200, y: 120, width: 940, height: 700 };

// A floor, not a preference: below roughly this the sidebar, the editor, and
// the terminal drawer stop coexisting. macOS will happily let someone drag a
// window smaller than this, and reopening at that size looks like breakage.
export const MIN_WIDTH = 640;
export const MIN_HEIGHT = 480;

// How much of the window has to remain on a screen for the frame to count as
// reachable: a strip of title bar wide enough to grab and drag back. Anything
// less and we re-center rather than restore.
const GRAB_WIDTH = 160;
const GRAB_HEIGHT = 44;

// --- pure core (unit-tested in windowFrame.test.ts) --------------------------

// A frame from disk, or null for "no usable frame" — absent file, truncated
// write, hand-edited nonsense. Every failure means the same thing to the
// caller, so none of them are distinguished.
export function parseFrame(text: string | null): Rect | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  const nums = [x, y, width, height];
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w >= GRAB_WIDTH && h >= GRAB_HEIGHT ? w * h : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

// Reconcile a saved frame with the screens that actually exist right now.
// `workAreas` are the displays' usable rectangles (menu bar and Dock already
// subtracted), PRIMARY FIRST — the caller orders them, because only the caller
// can ask the OS which one that is. Both rectangles are top-left-origin in one
// global space, so overlapping them is meaningful; that is a fact about
// Electrobun's API, established in index.ts where the two meet.
//
// Three outcomes: the frame is reachable and comes back as saved (resized to
// fit its display); the frame is stranded — unplugged monitor, a display that
// shrank — and its SIZE is kept but re-centered on the display it best
// matches, because size is a deliberate choice and position after a hardware
// change is not; or there is nothing saved and the default stands.
export function fitFrame(saved: Rect | null, workAreas: Rect[]): Rect {
  if (!saved) return { ...DEFAULT_FRAME };
  // No display info at all (the native call failed) — the file is the only
  // evidence we have, so honor it rather than moving the window on a guess.
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
  // Re-test after resizing: a window clamped down to fit can no longer be the
  // one whose overlap we measured.
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
// Synchronous on both ends, unlike the layout file: the read happens once
// before the window exists (nothing to overlap it with), and the write has to
// be callable from `process.on("exit")`, where a promise never resolves.

export function readFrame(): Rect | null {
  try {
    return parseFrame(readFileSync(WINDOW_PATH, "utf8"));
  } catch {
    // Nothing there: an install that predates the client home may still have
    // the old file. Move it rather than copy it, so there is only ever one
    // file being this window's position, and never fail over it — a lost
    // frame costs one launch its geometry.
    try {
      ensureClientHomeSync();
      renameSync(LEGACY_WINDOW_PATH, WINDOW_PATH);
      return parseFrame(readFileSync(WINDOW_PATH, "utf8"));
    } catch {
      return null;
    }
  }
}

let lastWritten = "";

// Best-effort: a frame that fails to save costs the next launch its position,
// which is not worth a dialog or a crash. Temp-plus-rename anyway — a half
// file would be discarded by parseFrame, but leaving one around invites
// someone to trust it later.
export function writeFrame(frame: Rect): void {
  const text = JSON.stringify(roundFrame(frame));
  if (text === lastWritten) return;
  try {
    ensureClientHomeSync();
    const tmp = `${WINDOW_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, WINDOW_PATH);
    lastWritten = text;
  } catch (err) {
    console.warn(`[window] could not save the window frame (${err})`);
  }
}
