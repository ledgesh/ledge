import { describe, expect, test } from "bun:test";
import { PRESS_SLOP, pressMoved, pressOpensMenu } from "./useRowMenu";

describe("which pointers open a menu by being held", () => {
  test("a finger does, because it has no second button", () => {
    expect(pressOpensMenu("touch")).toBe(true);
  });

  test("a pencil does, for the same reason", () => {
    expect(pressOpensMenu("pen")).toBe(true);
  });

  test("a mouse does not: it has the right button, and a held button is a drag", () => {
    expect(pressOpensMenu("mouse")).toBe(false);
  });

  // WebKit reports "" for a synthesized pointer with no type. Treating that as
  // touch would make every held mouse button on the desktop a menu.
  test("an untyped pointer does not", () => {
    expect(pressOpensMenu("")).toBe(false);
  });
});

describe("when a press has become a scroll", () => {
  const from = { x: 100, y: 200 };

  test("a still finger is still a press", () => {
    expect(pressMoved(from, { x: 100, y: 200 })).toBe(false);
  });

  test("drift within the slop is still a press: a finger is never still", () => {
    expect(pressMoved(from, { x: 100 + PRESS_SLOP, y: 200 - PRESS_SLOP })).toBe(false);
  });

  test("past the slop vertically it was a scroll, and the list owns it", () => {
    expect(pressMoved(from, { x: 100, y: 200 + PRESS_SLOP + 1 })).toBe(true);
  });

  test("past the slop horizontally it was a swipe", () => {
    expect(pressMoved(from, { x: 100 - PRESS_SLOP - 1, y: 200 })).toBe(true);
  });
});
