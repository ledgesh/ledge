import { test, expect, describe } from "bun:test";
import { DEFAULT_ICON, WORKSPACE_ICONS, iconFor, isIconKey } from "./icons";

describe("workspace icons", () => {
  test("the default is in the catalog, so the picker can show it as chosen", () => {
    expect(isIconKey(DEFAULT_ICON)).toBe(true);
  });

  test("keys are unique", () => {
    // The picker renders keyed by these; a duplicate is a React key collision
    // and two cells that highlight as one.
    const keys = WORKSPACE_ICONS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every entry carries a label and a component", () => {
    for (const i of WORKSPACE_ICONS) {
      expect({ key: i.key, label: i.label, icon: typeof i.Icon }).toMatchObject({
        label: expect.any(String),
        icon: expect.any(String),
      });
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.Icon).toBeDefined();
    }
  });

  test("an unknown key falls back to the default rather than nothing", () => {
    // A workspace row with no icon reads as broken, and keys can go stale.
    expect(iconFor("aardvark")).toBe(iconFor(DEFAULT_ICON));
    expect(isIconKey("aardvark")).toBe(false);
  });

  test("a known key resolves to its own component", () => {
    const rocket = WORKSPACE_ICONS.find((i) => i.key === "rocket")!;
    expect(iconFor("rocket")).toBe(rocket.Icon);
  });
});
