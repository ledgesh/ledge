import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chipOf, formatKey, jumpBadge, keyChip, middleEllipsis, modClick, tooltip } from "./format";
import { configureModKey } from "./modKey";

describe("formatKey", () => {
  test("letters uppercase with macOS glyph order ⌃⌥⇧⌘", () => {
    expect(formatKey("Mod-Shift-w")).toBe("⇧⌘W");
    // the glyph order comes from formatKey, not from the spelling
    expect(formatKey("Shift-Mod-w")).toBe("⇧⌘W");
    expect(formatKey("Alt-Mod-b")).toBe("⌥⌘B");
    expect(formatKey("Ctrl-Alt-Shift-Mod-x")).toBe("⌃⌥⇧⌘X");
  });

  test("named keys map to glyphs", () => {
    expect(formatKey("Mod-Enter")).toBe("⌘↩");
    expect(formatKey("Mod-Shift-Enter")).toBe("⇧⌘↩");
    expect(formatKey("Mod-Backspace")).toBe("⌘⌫");
    expect(formatKey("Ctrl-Tab")).toBe("⌃⇥");
    expect(formatKey("Escape")).toBe("⎋");
  });

  test("literals pass through", () => {
    expect(formatKey("Ctrl-`")).toBe("⌃`");
    expect(formatKey("Mod-1")).toBe("⌘1");
    expect(formatKey("F3")).toBe("F3");
    expect(formatKey("Mod-Shift-]")).toBe("⇧⌘]");
  });
});

describe("tooltip", () => {
  test("title plus advertised key", () => {
    expect(tooltip("tab.close")).toBe("Close Tab (⌘W)");
    expect(tooltip("pane.splitDown")).toBe("Split Down (⇧⌘D)");
    expect(tooltip("terminal.toggle")).toBe("Toggle Terminal (⌃`)");
  });

  test("title alone when unbound", () => {
    expect(tooltip("tab.closeOthers")).toBe("Close Other Tabs");
    expect(tooltip("block.copy")).toBe("Copy");
  });

  test("a row verb is advertised like any other key", () => {
    expect(tooltip("workspace.remove")).toBe("Delete Workspace (⌫)");
    expect(tooltip("note.delete")).toBe("Delete (D)");
  });

  test("explicit key override for dynamic commands", () => {
    expect(tooltip("tab.close", "Mod-1")).toBe("Close Tab (⌘1)");
  });
});

describe("keyChip", () => {
  test("formatted primary key, or null when menu-only", () => {
    expect(keyChip("pane.close")).toBe("⇧⌘W");
    expect(keyChip("tab.closeOthers")).toBeNull();
  });
});

describe("chipOf", () => {
  test("a chord outranks a row verb; either beats nothing", () => {
    expect(chipOf(["Mod-Backspace"], ["Backspace"])).toBe("⌘⌫");
    expect(chipOf(undefined, ["d", "Backspace"])).toBe("D");
    expect(chipOf([], [])).toBeNull();
  });
});

describe("middleEllipsis", () => {
  test("a fitting label passes through untouched", () => {
    expect(middleEllipsis("web1", 30)).toBe("web1");
    expect(middleEllipsis("123456", 6)).toBe("123456");
  });

  test("a long label keeps BOTH ends — the tail is what tells -01 from -02", () => {
    const a = middleEllipsis("ubuntu@anypost-app-prod-01", 20);
    const b = middleEllipsis("ubuntu@anypost-app-prod-02", 20);
    expect(a).toHaveLength(20);
    expect(a.startsWith("ubuntu@")).toBe(true);
    expect(a.endsWith("-01")).toBe(true);
    expect(b.endsWith("-02")).toBe(true);
    expect(a).not.toBe(b);
  });

  test("the result never exceeds max", () => {
    for (const max of [5, 8, 13, 20]) {
      expect(middleEllipsis("a".repeat(50) + "-tail", max).length).toBeLessThanOrEqual(max);
    }
  });
});

describe("formatKey where Mod is Ctrl", () => {
  beforeEach(() => configureModKey("Ctrl"));
  afterEach(() => configureModKey("Meta"));

  test("names joined with +, in Ctrl Shift Alt order", () => {
    expect(formatKey("Mod-Shift-w")).toBe("Ctrl+Shift+W");
    expect(formatKey("Shift-Mod-w")).toBe("Ctrl+Shift+W");
    expect(formatKey("Alt-Mod-b")).toBe("Ctrl+Alt+B");
    expect(formatKey("Mod-Alt-f")).toBe("Ctrl+Alt+F");
  });

  test("Mod and Ctrl are both Ctrl, printed once", () => {
    expect(formatKey("Ctrl-`")).toBe("Ctrl+`");
    expect(formatKey("Ctrl-Tab")).toBe("Ctrl+Tab");
    expect(formatKey("Ctrl-Mod-x")).toBe("Ctrl+X");
  });

  test("named keys are words, and a literal Meta is Super", () => {
    expect(formatKey("Mod-Enter")).toBe("Ctrl+Enter");
    expect(formatKey("Mod-Backspace")).toBe("Ctrl+Backspace");
    expect(formatKey("Escape")).toBe("Esc");
    expect(formatKey("Meta-x")).toBe("Super+X");
    expect(formatKey("F3")).toBe("F3");
  });

  test("tooltips and chips follow", () => {
    expect(tooltip("tab.close")).toBe("Close Tab (Ctrl+W)");
    expect(keyChip("palette.commands")).toBe("Ctrl+Shift+P");
    expect(modClick()).toBe("Ctrl-click");
  });

  test("the jump badges spell the platform's keys", () => {
    expect(jumpBadge("Mod-1")).toBe("Ctrl+1");
    expect(jumpBadge("Alt-1")).toBe("Alt+1");
  });
});

describe("the jump badges on a Mac", () => {
  test("⌘ for the workspace jump, an ASCII caret for the tab jump", () => {
    expect(jumpBadge("Mod-1")).toBe("⌘1");
    expect(jumpBadge("Ctrl-1")).toBe("^1");
    expect(modClick()).toBe("⌘-click");
  });
});
