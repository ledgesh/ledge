import { describe, expect, test } from "bun:test";
import { resolveAppearance } from "./theme";

// resolveAppearance is the pure core of lib/theme.ts. The DOM half is one
// dataset write and a matchMedia listener; that thin wrapper stays untested
// (testing.md §2).
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
