import { afterEach, describe, expect, test } from "bun:test";
import { applyKeys, normalizeChord, resolveKeys } from "./bindings";
import { COMMANDS, configureKeys, defaultKeysOf, keyOf, keysOf, userChords, type CommandId } from "./keys";
import { chordId } from "./keymap";
import { configureModKey } from "./modKey";

// The setting is module state in keys.ts, so every test leaves it as it found
// it: the rest of the suite reads the table as shipped.
afterEach(() => {
  configureKeys({ changed: {}, bound: [] });
  configureModKey("Meta");
});

const chord = (text: string) => {
  const r = normalizeChord(text);
  return "chord" in r ? r.chord : `refused: ${r.problem}`;
};

describe("normalizeChord", () => {
  test("the table's own spelling passes through", () => {
    for (const id of Object.keys(COMMANDS) as CommandId[]) {
      for (const key of defaultKeysOf(id)) expect(chordId(chord(key))).toBe(chordId(key));
    }
  });

  test("modifiers take the spellings people write, in any order and case", () => {
    expect(chord("shift-mod-D")).toBe("Mod-Shift-d");
    expect(chord("Cmd-Option-b")).toBe("Alt-Meta-b");
    expect(chord("Control-Alt-ArrowUp")).toBe("Ctrl-Alt-ArrowUp");
    expect(chord("  Mod-k ")).toBe("Mod-k");
  });

  test("the + a Ctrl desktop's chips print is a separator too", () => {
    expect(chord("Ctrl+Shift+W")).toBe("Ctrl-Shift-w");
  });

  test("a separator can be the key", () => {
    expect(chord("Mod--")).toBe("Mod--");
    expect(chord("Ctrl+-")).toBe("Ctrl--");
    expect(chordId(chord("Mod--"))).toBe(chordId("Mod--"));
  });

  test("named keys and function keys", () => {
    expect(chord("Mod-return")).toBe("Mod-Enter");
    expect(chord("Ctrl-Up")).toBe("Ctrl-ArrowUp");
    expect(chord("Mod-pagedown")).toBe("Mod-PageDown");
    expect(chord("Ctrl-space")).toBe("Ctrl-Space");
    expect(chord("f5")).toBe("F5");
    expect(chord("Shift-F12")).toBe("Shift-F12");
  });

  test("a key with nothing held is typing, and is refused", () => {
    expect(chord("d")).toContain("needs Mod, Ctrl or Alt");
    expect(chord("Shift-d")).toContain("needs Mod, Ctrl or Alt");
    expect(chord("Tab")).toContain("needs Mod, Ctrl or Alt");
    expect(chord("-")).toContain("needs Mod, Ctrl or Alt");
  });

  test("what is not a chord says which part is wrong", () => {
    expect(chord("")).toBe("refused: is empty");
    expect(chord("Mod-")).toBe("refused: is not a chord");
    expect(chord("Hyper-d")).toContain('"Hyper" where a modifier goes');
    expect(chord("Mod-Foo")).toContain('"Foo" where a key goes');
    expect(chord("Mod-F25")).toContain('"F25" where a key goes');
  });

  test("a shifted character is refused: the event reports the key it is on", () => {
    expect(chord("Mod-}")).toContain("shifted character");
    expect(chord("Mod-+")).toContain("shifted character");
    expect(chord("Mod-Shift-]")).toBe("Mod-Shift-]");
  });

  test("Escape is never a chord's key", () => {
    expect(chord("Mod-Escape")).toContain("Escape");
    expect(chord("Ctrl-esc")).toContain("Escape");
  });

  test("⌥ alone with a character is refused on a Mac, and is a chord elsewhere", () => {
    expect(chord("Alt-d")).toContain("types a character on a Mac");
    expect(chord("Alt-Shift-d")).toContain("types a character on a Mac");
    expect(chord("Alt-ArrowUp")).toBe("Alt-ArrowUp");
    expect(chord("Alt-Mod-d")).toBe("Alt-Mod-d");
    configureModKey("Ctrl");
    expect(chord("Alt-d")).toBe("Alt-d");
  });
});

describe("resolveKeys", () => {
  test("no setting changes nothing", () => {
    expect(resolveKeys({})).toEqual({ changed: {}, bound: [], problems: [] });
  });

  test("an entry replaces its command's chords, aliases included", () => {
    const r = resolveKeys({ "note.new": ["Mod-Alt-n"] });
    expect(r.problems).toEqual([]);
    expect(r.bound).toEqual(["note.new"]);
    // ⌥⌘N was New Note from Template's, which loses it.
    expect(r.changed).toEqual({ "note.new": ["Alt-Mod-n"], "note.fromTemplate": [] });
  });

  test("an assigned chord is taken from the command that shipped with it", () => {
    const r = resolveKeys({ "pane.splitRight": ["Mod-b"] });
    expect(r.problems).toEqual([]);
    expect(r.changed).toEqual({ "pane.splitRight": ["Mod-b"], "format.bold": [] });
  });

  test("a holder keeps the chords nobody asked for", () => {
    // ⌘T is New Note's alias. Taking it leaves ⌘N where it was.
    const r = resolveKeys({ "tags.toggle": ["Mod-t"] });
    expect(r.changed["note.new"]).toEqual(["Mod-n"]);
  });

  test("an empty list leaves the command with no chord, and frees the chord for nobody", () => {
    const r = resolveKeys({ "terminal.toggle": [] });
    expect(r.problems).toEqual([]);
    expect(r.changed).toEqual({ "terminal.toggle": [] });
    expect(r.bound).toEqual(["terminal.toggle"]);
  });

  test("a command that ships with no chord can be given one", () => {
    const r = resolveKeys({ "editor.duplicateLine": ["Mod-Shift-d"] });
    expect(r.problems).toEqual([]);
    expect(r.changed).toEqual({ "editor.duplicateLine": ["Mod-Shift-d"], "pane.splitDown": [] });
  });

  test("two entries asking for one chord: the first keeps it", () => {
    const r = resolveKeys({ "note.new": ["Mod-e"], "daily.open": ["Mod-e", "Mod-j"] });
    expect(r.problems).toEqual(['"keys.daily.open": "Mod-e" is already given to note.new']);
    expect(r.changed["note.new"]).toEqual(["Mod-e"]);
    // The usable half of the second entry is what it gets, which is its default.
    expect(r.changed["daily.open"]).toBeUndefined();
  });

  test("one chord under two spellings is one chord", () => {
    const r = resolveKeys({ "note.new": ["Shift-Mod-e"], "daily.open": ["Mod-Shift-E"] });
    expect(r.problems).toHaveLength(1);
  });

  test("an entry of nothing but mistakes keeps the defaults", () => {
    const r = resolveKeys({ "pane.splitRight": ["Mod-", "d"] });
    expect(r.problems).toHaveLength(2);
    expect(r.changed).toEqual({});
    expect(r.bound).toEqual([]);
  });

  test("one bad chord costs itself, not the entry", () => {
    const r = resolveKeys({ "pane.splitRight": ["garbage-d", "Mod-Alt-d"] });
    expect(r.problems).toHaveLength(1);
    expect(r.changed).toEqual({ "pane.splitRight": ["Alt-Mod-d"] });
  });

  test("an unknown id, and a command no chord can run", () => {
    const r = resolveKeys({ "note.nwe": ["Mod-e"], "block.copy": ["Mod-e"], "workspace.select.1": ["Mod-e"] });
    expect(r.problems).toEqual([
      '"keys.note.nwe" is not a command id',
      '"keys.block.copy" acts on what the pointer is over, so no chord can run it',
      '"keys.workspace.select.1" is not a command id',
    ]);
    expect(r.changed).toEqual({});
  });

  test("the indexed jumps cannot be taken", () => {
    const r = resolveKeys({ "note.new": ["Mod-1"], "daily.open": ["Ctrl-9"] });
    expect(r.problems).toEqual([
      '"keys.note.new": "Mod-1" is Switch to Workspace 1 and cannot be reassigned',
      '"keys.daily.open": "Ctrl-9" is Go to Tab 9 and cannot be reassigned',
    ]);
  });

  test("on a Mac the menu bar's own chords cannot be taken; elsewhere they are free", () => {
    expect(resolveKeys({ "note.new": ["Mod-h"] }).problems).toEqual([
      '"keys.note.new": "Mod-h" is Hide Ledge in the menu bar and cannot be reassigned',
    ]);
    expect(resolveKeys({ "note.new": ["Mod-z"] }).problems).toHaveLength(1);
    configureModKey("Ctrl");
    expect(resolveKeys({ "note.new": ["Mod-h"] }).problems).toEqual([]);
  });

  test("where Mod is Ctrl, a Ctrl spelling takes the Mod chord", () => {
    configureModKey("Ctrl");
    const r = resolveKeys({ "editor.selectNextOccurrence": ["Ctrl+D"] });
    expect(r.problems).toEqual([]);
    expect(r.changed).toEqual({ "editor.selectNextOccurrence": ["Ctrl-d"], "pane.splitRight": [] });
  });

  test("the resolved table never gives one chord to two commands", () => {
    const r = resolveKeys({
      "pane.splitRight": ["Mod-b", "Mod-i"],
      "format.bold": ["Mod-d"],
      "note.new": ["Mod-w", "Mod-Shift-w"],
    });
    expect(r.problems).toEqual([]);
    configureKeys(r);
    const seen = new Map<string, string>();
    for (const id of Object.keys(COMMANDS) as CommandId[]) {
      for (const key of keysOf(id)) {
        expect(`${key}: ${seen.get(chordId(key)) ?? ""}`).toBe(`${key}: `);
        seen.set(chordId(key), id);
      }
    }
  });
});

describe("applyKeys", () => {
  test("puts the setting in force for every reader of the table", () => {
    expect(applyKeys({ "pane.splitRight": ["Mod-Alt-d"], "terminal.toggle": [] })).toEqual([]);
    expect(keyOf("pane.splitRight")).toBe("Alt-Mod-d");
    expect(keysOf("terminal.toggle")).toEqual([]);
    expect(keyOf("terminal.toggle")).toBeNull();
    expect(defaultKeysOf("pane.splitRight")).toEqual(["Mod-d"]);
    // The editor binds the assigned chords ahead of its own keymaps.
    expect(userChords()).toEqual([{ id: "pane.splitRight", key: "Alt-Mod-d" }]);
  });

  test("returns the problems and still applies the rest", () => {
    expect(applyKeys({ "pane.splitRight": ["Mod-Alt-d"], nope: ["Mod-e"] })).toEqual(['"keys.nope" is not a command id']);
    expect(keyOf("pane.splitRight")).toBe("Alt-Mod-d");
  });
});
