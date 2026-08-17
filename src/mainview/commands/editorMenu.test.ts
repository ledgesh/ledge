import { describe, expect, test } from "bun:test";
import {
  EDITOR_MENU_COMMANDS,
  editorMenu,
  keepsSelection,
  type EditorClickContext,
} from "./editorMenu";
import { COMMANDS, type CommandId } from "./keys";

const PROSE: EditorClickContext = {
  onLink: false,
  onTask: false,
  onRunnableBlock: false,
  readOnly: false,
};

const at = (over: Partial<EditorClickContext> = {}) => editorMenu({ ...PROSE, ...over });
const verbs = (over: Partial<EditorClickContext> = {}) => at(over).filter((i) => i !== "---");

describe("the editor's context menu", () => {
  test("a right-click in prose offers the clipboard and the writing verbs", () => {
    expect(at()).toEqual([
      "editor.cut",
      "editor.copy",
      "editor.paste",
      "editor.pastePlain",
      "editor.selectAll",
      "---",
      "format.bold",
      "format.italic",
      "format.link",
      "format.wikiLink",
      "format.codeBlock",
      "image.insert",
    ]);
  });

  test("what the pointer landed on comes first, and only when it landed on it", () => {
    // The whole point of the contextual group: a menu that offered Open Link
    // over every paragraph would be teaching that its items do nothing.
    expect(verbs()).not.toContain("link.open");
    expect(verbs()).not.toContain("task.toggle");
    expect(at({ onLink: true })[0]).toBe("link.open");
    expect(at({ onTask: true })[0]).toBe("task.toggle");
    // A wikilink on a task line is both.
    expect(at({ onLink: true, onTask: true }).slice(0, 2)).toEqual(["link.open", "task.toggle"]);
  });

  test("a runnable block offers both runs, above everything else", () => {
    expect(at({ onRunnableBlock: true }).slice(0, 2)).toEqual([
      "block.runInline",
      "block.runInTerminal",
    ]);
    // §4c: the probe withholds the flag for an unterminated fence, so the pair
    // is simply absent rather than present and answering with a notice.
    expect(verbs()).not.toContain("block.runInline");
  });

  test("a read-only page keeps reading and loses writing", () => {
    // The manual (architecture.md §3b). Copy and Select All survive — copying
    // a command out of the docs is what the docs are for — and its runnable
    // demos still run.
    expect(at({ readOnly: true, onRunnableBlock: true })).toEqual([
      "block.runInline",
      "block.runInTerminal",
      "---",
      "editor.copy",
      "editor.selectAll",
    ]);
    for (const id of ["editor.cut", "editor.paste", "editor.pastePlain", "format.bold"]) {
      expect(verbs({ readOnly: true })).not.toContain(id as CommandId);
    }
  });

  test("no menu opens, closes, or doubles a separator", () => {
    // A group that came back empty must take its divider with it — the same
    // rule buildMenu holds the menu bar to, for the same reason: a hidden item
    // that leaves a visible gap says something is missing.
    for (const onLink of [true, false])
      for (const onTask of [true, false])
        for (const onRunnableBlock of [true, false])
          for (const readOnly of [true, false]) {
            const items = editorMenu({ onLink, onTask, onRunnableBlock, readOnly });
            expect(items[0]).not.toBe("---");
            expect(items[items.length - 1]).not.toBe("---");
            for (let i = 1; i < items.length; i += 1) {
              expect(items[i] === "---" && items[i - 1] === "---").toBe(false);
            }
          }
  });

  test("every id it can name is a real command", () => {
    // menu.test.ts's first check, for the other spec. The registry is asked
    // the same question in registry.test.ts, which also needs these ids to
    // count as reachable; here it is enough that the key table knows them.
    for (const id of EDITOR_MENU_COMMANDS) expect(COMMANDS[id]).toBeDefined();
    expect(EDITOR_MENU_COMMANDS.length).toBeGreaterThan(0);
  });
});

describe("the caret a right-click places", () => {
  const sel = (from: number, to: number) => ({ from, to, empty: from === to });

  test("a click inside a selection keeps it — that is what the menu is about", () => {
    expect(keepsSelection([sel(4, 10)], 7)).toBe(true);
    // Both edges count: a click on the last character of a selection is a
    // click on the selection.
    expect(keepsSelection([sel(4, 10)], 4)).toBe(true);
    expect(keepsSelection([sel(4, 10)], 10)).toBe(true);
  });

  test("a click outside it moves the caret, so Cut cannot act off screen", () => {
    expect(keepsSelection([sel(4, 10)], 3)).toBe(false);
    expect(keepsSelection([sel(4, 10)], 11)).toBe(false);
  });

  test("an empty selection is not a selection", () => {
    // A bare caret at 7 must not make a click at 7 "inside a selection": there
    // is nothing to keep, and the caret should move to where the click was.
    expect(keepsSelection([sel(7, 7)], 7)).toBe(false);
    expect(keepsSelection([], 7)).toBe(false);
  });

  test("any range counts, not just the main one", () => {
    // Find's "All" selects every match; right-clicking one of them must not
    // collapse the rest.
    expect(keepsSelection([sel(0, 3), sel(20, 25)], 22)).toBe(true);
  });
});
