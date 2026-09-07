import { test, expect, describe } from "bun:test";
import { DEFAULT_ICON, WORKSPACE_ICONS, iconFor, isIconKey } from "./icons";

describe("workspace icons", () => {
  test("the default is in the catalog, so the picker can show it as chosen", () => {
    expect(isIconKey(DEFAULT_ICON)).toBe(true);
  });

  test("keys are unique", () => {
    // IconPicker.tsx renders one button per entry, keyed by i.key. A
    // duplicate gives React two children with the same key. When the
    // duplicated key is also the workspace's current icon, both of those
    // buttons highlight as chosen. Focus opens on the first of them.
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
    // The sidebar draws each workspace row's icon with iconFor
    // (Sidebar.tsx). Keys can go stale. A row with no icon looks broken, so
    // the fallback keeps every row showing one.
    expect(iconFor("aardvark")).toBe(iconFor(DEFAULT_ICON));
    expect(isIconKey("aardvark")).toBe(false);
  });

  test("a known key resolves to its own component", () => {
    const rocket = WORKSPACE_ICONS.find((i) => i.key === "rocket")!;
    expect(iconFor("rocket")).toBe(rocket.Icon);
  });
});
