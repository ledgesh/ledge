import { describe, expect, test } from "bun:test";
import { MENU_MARGIN, placeMenu } from "./menuPlacement";

// A phone (ios.md §13) and a desktop window. The phone is where every clamp
// below actually fires.
const PHONE = { w: 390, h: 844 };
const DESKTOP = { w: 1440, h: 900 };
const MENU = { w: 200, h: 180 };

describe("placing a menu", () => {
  test("a menu with room hangs from the point it was opened at", () => {
    expect(placeMenu({ x: 300, y: 200 }, MENU, DESKTOP)).toEqual({ x: 300, y: 200 });
  });

  test("a menu that would run off the bottom flips above the point", () => {
    // 800 + 180 is past 844, so it opens upward — the platform's own answer,
    // and the one that leaves the row it is about uncovered.
    expect(placeMenu({ x: 20, y: 800 }, MENU, PHONE)).toEqual({ x: 20, y: 620 });
  });

  test("a menu that would run off the right slides back, it does not flip", () => {
    // Flipping would put it under the hand that opened it.
    expect(placeMenu({ x: 380, y: 100 }, MENU, PHONE)).toEqual({ x: 182, y: 100 });
  });

  test("the bottom edge is the menu's END, not its start", () => {
    // The bug this replaces clamped the TOP to a guessed 88px above the
    // bottom, so a menu of any real height still ran off it.
    const at = placeMenu({ x: 20, y: 843 }, MENU, PHONE);
    expect(at.y + MENU.h).toBeLessThanOrEqual(PHONE.h);
  });

  test("a press in the corner still yields a menu wholly on screen", () => {
    const at = placeMenu({ x: 389, y: 843 }, MENU, PHONE);
    expect(at.x).toBeGreaterThanOrEqual(MENU_MARGIN);
    expect(at.y).toBeGreaterThanOrEqual(MENU_MARGIN);
    expect(at.x + MENU.w).toBeLessThanOrEqual(PHONE.w);
    expect(at.y + MENU.h).toBeLessThanOrEqual(PHONE.h);
  });

  test("a menu taller than the screen starts at the top rather than above it", () => {
    // Clipped at the bottom is recoverable; started off the top is a menu
    // whose first item cannot be reached at all.
    expect(placeMenu({ x: 20, y: 400 }, { w: 200, h: 900 }, PHONE).y).toBe(MENU_MARGIN);
  });

  test("a menu wider than the screen starts at the left edge", () => {
    expect(placeMenu({ x: 200, y: 100 }, { w: 500, h: 100 }, PHONE).x).toBe(MENU_MARGIN);
  });
});
