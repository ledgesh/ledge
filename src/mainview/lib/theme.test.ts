import { describe, expect, test } from "bun:test";
import { resolveAppearance } from "./theme";

// The pure core of lib/theme.ts; the DOM half (one dataset write plus a
// matchMedia listener) is the thin wrapper testing.md §2 leaves untested.
describe("resolveAppearance", () => {
  test('"system" is whatever the OS is wearing', () => {
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("system", false)).toBe("light");
  });

  test("a forced theme ignores the OS entirely — that is the whole point", () => {
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
  });
});
