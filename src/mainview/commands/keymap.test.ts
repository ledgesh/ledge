import { describe, expect, test } from "bun:test";
import {
  eventToChord,
  matchesKey,
  parseKey,
  resolveChord,
  type Chord,
  type FocusDomain,
} from "./keymap";

function ev(partial: Partial<KeyboardEvent> & { key: string; code?: string }) {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("eventToChord", () => {
  test("shifted letters normalize to lowercase", () => {
    const c = eventToChord(ev({ key: "W", metaKey: true, shiftKey: true }));
    expect(c.key).toBe("w");
    expect(c.shift).toBe(true);
    expect(c.meta).toBe(true);
  });

  test("shifted punctuation recovers the base key from e.code", () => {
    const c = eventToChord(ev({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }));
    expect(c.key).toBe("]");
  });

  test("shifted digits recover the digit from e.code", () => {
    const c = eventToChord(ev({ key: "!", code: "Digit1", metaKey: true, shiftKey: true }));
    expect(c.key).toBe("1");
  });

  test("⌥-transformed punctuation recovers the base key from e.code", () => {
    // macOS Option types "≤" on the comma key; Alt-Mod-, must still match.
    const c = eventToChord(ev({ key: "≤", code: "Comma", metaKey: true, altKey: true }));
    expect(c.key).toBe(",");
    expect(c.alt).toBe(true);
  });

  test("backtick, digits, and named keys pass through", () => {
    expect(eventToChord(ev({ key: "`", code: "Backquote", ctrlKey: true })).key).toBe("`");
    expect(eventToChord(ev({ key: "1", code: "Digit1", ctrlKey: true })).key).toBe("1");
    expect(eventToChord(ev({ key: "Enter", metaKey: true })).key).toBe("Enter");
    expect(eventToChord(ev({ key: "Backspace", metaKey: true })).key).toBe("Backspace");
    expect(eventToChord(ev({ key: "Tab", ctrlKey: true })).key).toBe("Tab");
  });
});

describe("matchesKey", () => {
  test("meta vs ctrl are distinct", () => {
    const cmdT: Chord = { key: "t", meta: true, ctrl: false, alt: false, shift: false };
    const ctrlT: Chord = { key: "t", meta: false, ctrl: true, alt: false, shift: false };
    expect(matchesKey("Mod-t", cmdT)).toBe(true);
    expect(matchesKey("Mod-t", ctrlT)).toBe(false);
    expect(matchesKey("Ctrl-t", ctrlT)).toBe(true);
  });

  test("shift must match exactly", () => {
    const shifted: Chord = { key: "d", meta: true, ctrl: false, alt: false, shift: true };
    expect(matchesKey("Mod-Shift-d", shifted)).toBe(true);
    expect(matchesKey("Mod-d", shifted)).toBe(false);
  });

  test("modifier spelling order does not matter", () => {
    const c = parseKey("Shift-Mod-w");
    expect(c).toEqual(parseKey("Mod-Shift-w"));
  });
});

describe("resolveChord", () => {
  const commands = [
    { id: "tab.close", keys: ["Mod-w"] },
    { id: "tab.select.1", keys: ["Ctrl-1"], domains: ["page", "editor"] as FocusDomain[] },
    { id: "terminal.toggle", keys: ["Ctrl-`"], domains: ["page"] as FocusDomain[] },
    { id: "menu.only" }, // no keys: never resolvable
  ];
  const chord = (key: string, mods: Partial<Chord> = {}): Chord => ({
    key,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    ...mods,
  });

  test("default domains cover page, editor, and terminal", () => {
    for (const domain of ["page", "editor", "terminal"] as const) {
      const hit = resolveChord(commands, chord("w", { meta: true }), { domain, modalOpen: false });
      expect(hit?.id).toBe("tab.close");
    }
  });

  test("ctrl chords stay out of the terminal domain", () => {
    const c = chord("1", { ctrl: true });
    expect(resolveChord(commands, c, { domain: "page", modalOpen: false })?.id).toBe("tab.select.1");
    expect(resolveChord(commands, c, { domain: "terminal", modalOpen: false })).toBeNull();
  });

  test("editor-owned chords are not window-dispatched in the editor", () => {
    const c = chord("`", { ctrl: true });
    expect(resolveChord(commands, c, { domain: "page", modalOpen: false })?.id).toBe("terminal.toggle");
    // In the editor, the CodeMirror keymap owns Ctrl-` and preventDefaults it;
    // domains: ["page"] keeps the window layer from double-firing if it ever
    // saw the event anyway.
    expect(resolveChord(commands, c, { domain: "editor", modalOpen: false })).toBeNull();
  });

  test("a modal layer suppresses everything", () => {
    const c = chord("w", { meta: true });
    expect(resolveChord(commands, c, { domain: "page", modalOpen: true })).toBeNull();
  });

  test("bare keys and shift-only are typing, not chords", () => {
    expect(resolveChord(commands, chord("w"), { domain: "page", modalOpen: false })).toBeNull();
    expect(
      resolveChord(commands, chord("w", { shift: true }), { domain: "page", modalOpen: false }),
    ).toBeNull();
  });
});

describe("resolveChord in the list domain", () => {
  const commands = [
    { id: "note.open", listKeys: ["Enter"], targetKind: "note" },
    { id: "note.delete", listKeys: ["d", "Backspace"], targetKind: "note" },
    { id: "note.restore", listKeys: ["r"], targetKind: "trash" },
    { id: "workspace.rename", listKeys: ["r"], targetKind: "workspace" },
    { id: "note.new", keys: ["Mod-n"] },
    { id: "note.deleteCurrent", keys: ["Mod-Backspace"], domains: ["page"] as FocusDomain[] },
  ];
  const chord = (key: string, mods: Partial<Chord> = {}): Chord => ({
    key,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    ...mods,
  });
  const on = (targetKind?: string) => ({ domain: "list" as const, modalOpen: false, targetKind });

  test("bare keys fire on a focused row", () => {
    expect(resolveChord(commands, chord("d"), on("note"))?.id).toBe("note.delete");
    expect(resolveChord(commands, chord("Backspace"), on("note"))?.id).toBe("note.delete");
    expect(resolveChord(commands, chord("Enter"), on("note"))?.id).toBe("note.open");
  });

  test("the same bare key means different things on different rows", () => {
    expect(resolveChord(commands, chord("r"), on("trash"))?.id).toBe("note.restore");
    expect(resolveChord(commands, chord("r"), on("workspace"))?.id).toBe("workspace.rename");
    // A row kind with no verb for `r` gets nothing, rather than the first one.
    expect(resolveChord(commands, chord("r"), on("note"))).toBeNull();
  });

  test("a row verb never fires off its row", () => {
    for (const domain of ["page", "editor", "terminal"] as const) {
      expect(
        resolveChord(commands, chord("d"), { domain, modalOpen: false, targetKind: "note" }),
      ).toBeNull();
    }
    // Nor with no row focused at all.
    expect(resolveChord(commands, chord("d"), on(undefined))).toBeNull();
  });

  test("page commands still work with a row focused", () => {
    // Focusing a note row must not cost you ⌘N: list is inside the page.
    expect(resolveChord(commands, chord("n", { meta: true }), on("note"))?.id).toBe("note.new");
    expect(resolveChord(commands, chord("Backspace", { meta: true }), on("note"))?.id).toBe(
      "note.deleteCurrent",
    );
  });

  test("a modal layer suppresses row verbs too", () => {
    expect(
      resolveChord(commands, chord("d"), { domain: "list", modalOpen: true, targetKind: "note" }),
    ).toBeNull();
  });
});
