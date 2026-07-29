import { describe, expect, test } from "bun:test";
import { isNascentBullet } from "./setext";

describe("isNascentBullet", () => {
  test("a lone dash is the underline that is also a list marker", () => {
    for (const line of ["-", "- ", "  -", "\t- ", "-\t"]) {
      expect(isNascentBullet(line)).toBe(true);
    }
  });

  test("two dashes or more is an underline someone meant", () => {
    for (const line of ["--", "---", " --- "]) {
      expect(isNascentBullet(line)).toBe(false);
    }
  });

  test("a dash with content is already a list item, nothing to suppress", () => {
    for (const line of ["- a", "-a", "- [ ]"]) {
      expect(isNascentBullet(line)).toBe(false);
    }
  });

  test("the other markers never underline anything", () => {
    for (const line of ["*", "+", "1.", "=", "", "   "]) {
      expect(isNascentBullet(line)).toBe(false);
    }
  });

  test("a trailing CR (pasted CRLF text) does not defeat the match", () => {
    expect(isNascentBullet("-\r")).toBe(true);
  });
});
