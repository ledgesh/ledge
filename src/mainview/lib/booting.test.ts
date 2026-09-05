import { describe, expect, test } from "bun:test";
import { bootingLabel } from "./booting";

describe("bootingLabel", () => {
  test("names the machine being dialled", () => {
    expect(bootingLabel("dan@vps.example")).toBe("Connecting to dan@vps.example…");
  });

  test("a boot that cannot name the machine yet still says what it is doing", () => {
    expect(bootingLabel("")).toBe("Connecting…");
  });

  test("a destination that is only whitespace is no destination", () => {
    expect(bootingLabel("   ")).toBe("Connecting…");
  });

  test("surrounding whitespace never reaches the sentence", () => {
    expect(bootingLabel("  dan@vps  ")).toBe("Connecting to dan@vps…");
  });
});
