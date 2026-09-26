// Windows' spell checker (bun/winspell.ts). The COM calls need Windows and are
// probed there (testing.md §6). What runs anywhere is the GUID encoding they
// depend on.
import { expect, test } from "bun:test";
import { guidBytes } from "./winspell";

test("a GUID's first three groups are little-endian and the rest is in order", () => {
  expect(guidBytes("7AB36653-1796-484B-BDFA-E74F1DB7C1DC").toString("hex")).toBe("5366b37a96174b48bdfae74f1db7c1dc");
});
