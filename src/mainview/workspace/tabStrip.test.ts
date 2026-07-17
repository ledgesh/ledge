import { describe, expect, test } from "bun:test";
import { clippedEdges, wheelTravel } from "./tabStrip";

describe("clippedEdges", () => {
  test("a strip whose content fits clips neither edge", () => {
    expect(clippedEdges(0, 400, 400)).toEqual({ left: false, right: false });
  });

  test("scrolled to the start, only the right edge clips", () => {
    expect(clippedEdges(0, 400, 900)).toEqual({ left: false, right: true });
  });

  test("scrolled into the middle, both edges clip", () => {
    expect(clippedEdges(250, 400, 900)).toEqual({ left: true, right: true });
  });

  test("scrolled to the end, only the left edge clips", () => {
    expect(clippedEdges(500, 400, 900)).toEqual({ left: true, right: false });
  });

  test("a fractional end position within 1px still counts as the end", () => {
    expect(clippedEdges(499.4, 400, 900)).toEqual({ left: true, right: false });
  });

  test("a fractional start position within 1px still counts as the start", () => {
    expect(clippedEdges(0.6, 400, 900)).toEqual({ left: false, right: true });
  });
});

describe("wheelTravel", () => {
  test("a dominant deltaY (mouse wheel) is remapped to horizontal travel", () => {
    expect(wheelTravel(0, 120)).toBe(120);
    expect(wheelTravel(2, -40)).toBe(-40);
  });

  test("a dominant deltaX (trackpad pan) is left to native scrolling", () => {
    expect(wheelTravel(80, 3)).toBe(0);
    expect(wheelTravel(-80, 0)).toBe(0);
  });

  test("a diagonal tie goes to native scrolling, not a double-apply", () => {
    expect(wheelTravel(5, 5)).toBe(0);
  });
});
