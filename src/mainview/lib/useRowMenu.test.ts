import { describe, expect, test } from "bun:test";
import { PRESS_SLOP, pressIsSelection, pressMoved, pressOpensMenu } from "./useRowMenu";

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

  // WebKit reports "" for a synthesized pointer with no type. On the desktop,
  // treating that as touch would let a held mouse button open the menu.
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

describe("which long presses the system keeps", () => {
  const inside = (selector: string) => ({ closest: (s: string) => (s.includes(selector) ? {} : null) });
  const nowhere = { closest: () => null };

  test("a finger held on a note's text, for the system's selection", () => {
    expect(pressIsSelection({ pointerType: "touch", target: inside(".cm-editor") })).toBe(true);
  });

  test("a finger held in a field, such as the search box", () => {
    expect(pressIsSelection({ pointerType: "touch", target: inside("input") })).toBe(true);
  });

  test("not a finger held anywhere else, where the page's menus answer", () => {
    expect(pressIsSelection({ pointerType: "touch", target: nowhere })).toBe(false);
  });

  test("not a right-click on text, which opens the editor's own menu", () => {
    expect(pressIsSelection({ pointerType: "mouse", target: inside(".cm-editor") })).toBe(false);
  });
});
