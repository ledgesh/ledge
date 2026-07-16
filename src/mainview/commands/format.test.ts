import { describe, expect, test } from "bun:test";
import { chipOf, formatKey, keyChip, tooltip } from "./format";

describe("formatKey", () => {
  test("letters uppercase with macOS glyph order ⌃⌥⇧⌘", () => {
    expect(formatKey("Mod-Shift-w")).toBe("⇧⌘W");
    expect(formatKey("Shift-Mod-w")).toBe("⇧⌘W"); // order comes from us, not the spelling
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
    expect(tooltip("workspace.close")).toBe("Close Workspace (⌫)");
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
