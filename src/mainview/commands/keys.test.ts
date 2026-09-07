import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  RESERVED_KEYS,
  keyOf,
  keysOf,
  listKeysOf,
  tabSelectKey,
  titleOf,
  workspaceSelectKey,
  type CommandId,
} from "./keys";
import { parseKey } from "./keymap";

const ids = Object.keys(COMMANDS) as CommandId[];

describe("command key table", () => {
  test("no binding is claimed by two commands", () => {
    const seen = new Map<string, CommandId>();
    for (const id of ids) {
      for (const key of keysOf(id)) {
        // Normalize through parseKey so "Mod-Shift-w" and "Shift-Mod-w" collide.
        const c = parseKey(key);
        const norm = `${c.ctrl}|${c.alt}|${c.shift}|${c.meta}|${c.key}`;
        expect(seen.get(norm)).toBeUndefined();
        seen.set(norm, id);
      }
    }
  });

  test("reserved keys are unbound", () => {
    const reserved = RESERVED_KEYS.map((k) => JSON.stringify(parseKey(k)));
    for (const id of ids) {
      for (const key of keysOf(id)) {
        expect(reserved).not.toContain(JSON.stringify(parseKey(key)));
      }
    }
  });

  test("indexed jumps do not collide with static bindings", () => {
    const indexed: string[] = [];
    for (let n = 1; n <= 9; n += 1) indexed.push(workspaceSelectKey(n), tabSelectKey(n));
    const statics = ids.flatMap((id) => [...keysOf(id)]);
    for (const key of indexed) expect(statics).not.toContain(key);
  });

  test("badge semantics are pinned: ⌘N = workspace, ⌃N = tab", () => {
    // The quick-jump badges number workspace rows (workspace/Sidebar.tsx) and
    // the focused pane's tabs (workspace/PaneTree.tsx) while ⌘ or ⌃ is held.
    // They draw the digit alone, never the modifier, so which modifier reaches
    // which list is pinned here. Swapping these two in commands/keys.ts sends
    // every badge to the wrong list.
    expect(workspaceSelectKey(1)).toBe("Mod-1");
    expect(tabSelectKey(1)).toBe("Ctrl-1");
  });

  test("every command has a nonempty title", () => {
    for (const id of ids) expect(titleOf(id).length).toBeGreaterThan(0);
  });

  test("row verbs are bare keys", () => {
    // A binding with a modifier is a chord, and chords go in `keys`, never in
    // `listKeys` (interactions.md §2). Shift is barred by that rule, not by
    // the resolver: resolveChord in keymap.ts counts a shift-only event as
    // bare, so a shifted row verb would in fact fire.
    for (const id of ids) {
      for (const binding of listKeysOf(id)) {
        expect({ id, binding, ...parseKey(binding) }).toMatchObject({
          meta: false,
          ctrl: false,
          alt: false,
          shift: false,
        });
      }
    }
  });

  test("a command with both advertises its chord, not its row verb", () => {
    // ⌘⌫ works anywhere in the page; ⌫ needs the row focused. keyOf returns
    // the chord first, so the tooltip shows ⌘⌫.
    expect(keyOf("note.deleteCurrent")).toBe("Mod-Backspace");
    expect(keyOf("note.delete")).toBe("d"); // no chord: the row verb is all there is
  });

  test("the shift rule pairs scope siblings on the same base key", () => {
    // interactions.md §2: ⇧ means "bigger scope" of the same key.
    const pairs: Array<[CommandId, CommandId]> = [
      ["tab.close", "pane.close"],
      ["pane.splitRight", "pane.splitDown"],
      ["note.new", "workspace.new"],
      ["palette.notes", "palette.commands"],
      ["block.runInline", "block.runInTerminal"],
    ];
    for (const [small, big] of pairs) {
      const s = parseKey(keyOf(small)!);
      const b = parseKey(keyOf(big)!);
      expect(b.key).toBe(s.key);
      expect(b.shift).toBe(true);
      expect(s.shift).toBe(false);
    }
  });
});
