import { describe, expect, test } from "bun:test";
import { initialState, type Action, type AppState } from "@/workspace/store";
import { firstLeaf } from "@/workspace/tree";
import { buildCommands } from "./registry";
import { INNER_OWNED_CHORDS, MENU, acceleratorOf, buildMenu, shellOwnsChord, type MenuItem } from "./menu";
import type { AppMenuItem } from "../../shared/rpc-schema";
import type { Command, CommandCtx, CommandTarget, RegistryDeps } from "./types";

const FOLDER = "/ws/notes";

// The menu never runs a command in these tests — it only reads titles, keys,
// and `when` — so the stub is inert where registry.test.ts's records calls.
// The values that steer a `when` (vault state, docs folder, the live note
// head) are the parameters, since what the menu shows is exactly what they
// decide.
function stubDeps(over: Partial<RegistryDeps> = {}): RegistryDeps {
  const noop = () => {};
  return {
    copyText: noop,
    installCli: async () => ({ ok: true, message: "" }),
    revealLog: noop,
    newWindow: noop,
    createWorkspace: async () => null,
    attachWorkspace: async () => null,
    closeWorkspace: noop,
    moveWorkspace: async () => null,
    workspaceKind: () => "external",
    docsFolder: () => null,
    openDocs: async () => {},
    closeDocs: noop,
    restartSession: noop,
    revealBacklink: noop,
    jumpToHeading: noop,
    openDailyNote: async () => null,
    newNoteFromTemplate: async () => ({ path: "/ws/n.md", title: "Untitled", mtimeMs: 0 }),
    createNote: async () => ({ path: "/ws/n.md", title: "Untitled", mtimeMs: 0 }),
    dailyRoot: () => null,
    vaultState: () => "unlocked",
    lockVaultNow: noop,
    lockNoteNow: async () => ({ error: null, notice: null }),
    removeLockNow: async () => null,
    openNoteIn: noop,
    noteHead: () => null,
    hasSelection: () => true,
    editor: {
      find: noop,
      replace: noop,
      save: noop,
      cut: noop,
      copy: noop,
      paste: noop,
      pastePlain: noop,
      selectAll: noop,
      runInline: noop,
      runInTerminal: noop,
      openLink: noop,
      toggleTask: noop,
      bold: noop,
      italic: noop,
      insertLink: noop,
      indent: noop,
      outdent: noop,
      wikiLink: noop,
      codeBlock: noop,
      insertImage: noop,
      toggleTemplate: noop,
      editFrontmatter: noop,
    },
    ...over,
  };
}

function makeCtx(state: AppState = initialState(FOLDER)): CommandCtx {
  return {
    state,
    selected: state.workspaces.find((w) => w.id === state.selectedId) ?? state.workspaces[0]!,
    dispatch: (_a: Action) => {},
    ui: {},
  };
}

// Every command item in the spec, submenus included.
function specCommands(items: readonly MenuItem[] = MENU.flatMap((s) => s.items)): Extract<
  MenuItem,
  { command: string }
>[] {
  const out: Extract<MenuItem, { command: string }>[] = [];
  for (const item of items) {
    if (item === "---") continue;
    if ("items" in item) out.push(...specCommands(item.items));
    else if ("command" in item) out.push(item);
  }
  return out;
}

// Every built item, flattened, so assertions can talk about the whole bar.
function flatten(items: AppMenuItem[]): AppMenuItem[] {
  return items.flatMap((item) => ("submenu" in item && item.submenu ? [item, ...flatten(item.submenu)] : [item]));
}

const commands = buildCommands(stubDeps());
const byId = new Map(commands.map((c) => [c.id, c]));

describe("menu spec", () => {
  test("every item names a command the registry actually builds", () => {
    const missing = specCommands()
      .map((i) => i.command)
      .filter((id) => !byId.has(id));
    expect(missing).toEqual([]);
  });

  test("no item names a command that needs a focused row", () => {
    // interactions.md §10: the menu bar has no row to point at, so a verb
    // whose `when` only passes WITH a target (Open, Restore, Copy Path, Close
    // Other Tabs) could only ever appear greyed. The test is the flip: does
    // handing the command a target turn its `when` from false to true?
    const state = initialState(FOLDER, [{ path: `${FOLDER}/a.md`, title: "A", mtimeMs: 0 }]);
    const ctx = makeCtx(state);
    const leaf = firstLeaf(ctx.selected.root);
    const targets: CommandTarget[] = [
      { kind: "workspace", id: ctx.selected.id },
      { kind: "note", path: `${FOLDER}/a.md` },
      { kind: "trash", path: `${FOLDER}/.ledge-trash/a.md` },
      { kind: "tab", paneId: leaf.id, tabId: leaf.tabs[0]!.id },
      { kind: "pane", paneId: leaf.id },
    ];
    const rowScoped = specCommands()
      .map((i) => byId.get(i.command))
      .filter((c): c is Command => !!c && !!c.when)
      .filter((c) => !c.when!(ctx) && targets.some((target) => c.when!({ ...ctx, target })))
      .map((c) => c.id);
    expect(rowScoped).toEqual([]);
  });

  test("no item claims a chord an inner handler already owns", () => {
    // interactions.md §10: AppKit's key-equivalent pass runs before the
    // WebView, so claiming one of these would take it from CodeMirror or the
    // shell for good. The item may still exist — it just carries no shortcut.
    const stolen = specCommands()
      .filter((i) => i.accelerator !== false)
      .map((i) => ({ id: i.command, binding: i.key ?? byId.get(i.command)?.keys?.[0] }))
      .filter((i) => !!i.binding)
      .filter((i) => INNER_OWNED_CHORDS.includes(i.binding!) || shellOwnsChord(i.binding!))
      .map((i) => `${i.id} (${i.binding})`);
    expect(stolen).toEqual([]);
  });

  test("nothing suppresses an accelerator it could safely have claimed", () => {
    // The other direction: `accelerator: false` is a hazard marker, not a
    // shrug. A suppression with no owner to protect is a shortcut the menu is
    // hiding for no reason.
    const idle = specCommands()
      .filter((i) => i.accelerator === false)
      .map((i) => ({ id: i.command, binding: i.key ?? byId.get(i.command)?.keys?.[0] }))
      .filter((i) => !!i.binding)
      .filter((i) => !INNER_OWNED_CHORDS.includes(i.binding!) && !shellOwnsChord(i.binding!))
      .map((i) => `${i.id} (${i.binding})`);
    expect(idle).toEqual([]);
  });

  test("an advertised alias is a binding the command really has", () => {
    for (const item of specCommands()) {
      if (!item.key) continue;
      expect(byId.get(item.command)?.keys ?? []).toContain(item.key);
    }
  });
});

describe("buildMenu", () => {
  const built = buildMenu(commands, makeCtx());
  const flat = flatten(built);

  test("no two items claim the same accelerator", () => {
    const seen = new Map<string, string>();
    for (const item of flat) {
      if ("type" in item || !item.accelerator) continue;
      const owner = item.action ?? item.role ?? item.label;
      expect(seen.has(item.accelerator) ? `${item.accelerator} (${seen.get(item.accelerator)})` : "").toBe("");
      seen.set(item.accelerator, owner);
    }
  });

  test("every accelerator spells a binding the dispatcher answers", () => {
    for (const item of flat) {
      if ("type" in item || !item.action || !item.accelerator) continue;
      const keys = byId.get(item.action)?.keys ?? [];
      expect(keys.map(acceleratorOf)).toContain(item.accelerator);
    }
  });

  test("a disabled command greys rather than vanishes, unless it asked to hide", () => {
    // A fresh state has one pane, so Close Pane is refused — and stays
    // visible, because a menu that drops what it cannot do right now teaches
    // nobody it exists. Only the items that opted into hiding disappear
    // (the workspace slots past the first, checked below).
    const closePane = flat.find((i) => !("type" in i) && i.action === "pane.close");
    expect(closePane).toBeDefined();
    expect(closePane && "enabled" in closePane ? closePane.enabled : null).toBe(false);
    expect(flat.some((i) => !("type" in i) && i.action === "workspace.select.2")).toBe(false);
  });

  test("the workspace submenu keeps only live slots, named for the workspace", () => {
    const switcher = flat.find((i) => "label" in i && i.label === "Switch to Workspace");
    const slots = (switcher && "submenu" in switcher && switcher.submenu) || [];
    // initialState has exactly one workspace, so slot 1 is live and 2…9 are not.
    expect(slots.length).toBe(1);
    expect(slots[0] && "label" in slots[0] ? slots[0].label : null).toBe("Scratch");
  });

  test("no section opens, closes, or doubles a divider", () => {
    for (const section of built) {
      const items = ("submenu" in section && section.submenu) || [];
      expect(items[0] && "type" in items[0]).toBeFalsy();
      expect(items[items.length - 1] && "type" in items[items.length - 1]!).toBeFalsy();
      for (let i = 1; i < items.length; i += 1) {
        expect("type" in items[i]! && "type" in items[i - 1]!).toBe(false);
      }
    }
  });

  test("a locked-vault state swaps which lock face the menu shows", () => {
    const locked = buildMenu(buildCommands(stubDeps({ vaultState: () => "locked" })), makeCtx());
    const faces = (m: AppMenuItem[]) =>
      flatten(m)
        .filter((i) => !("type" in i) && (i.action === "vault.lock" || i.action === "vault.unlock"))
        .map((i) => ("type" in i ? "" : `${i.action}:${i.enabled}`));
    expect(faces(built)).toEqual(["vault.lock:true", "vault.unlock:false"]);
    expect(faces(locked)).toEqual(["vault.lock:false", "vault.unlock:true"]);
  });
});

describe("acceleratorOf", () => {
  test("spells a chord the way the native parser reads it", () => {
    // Modifiers come out in the canonical macOS order (⌃⌥⇧⌘), the same order
    // format.ts renders glyphs in — the parser ORs them either way, and one
    // order in the repo is one fewer thing to disagree about.
    expect(acceleratorOf("Mod-n")).toBe("command+n");
    expect(acceleratorOf("Mod-Shift-p")).toBe("shift+command+p");
    expect(acceleratorOf("Alt-Mod-b")).toBe("option+command+b");
    expect(acceleratorOf("Ctrl-`")).toBe("control+`");
    expect(acceleratorOf("Mod-,")).toBe("command+,");
  });

  test("orders modifiers canonically, whatever the binding's spelling", () => {
    expect(acceleratorOf("Mod-Alt-f")).toBe(acceleratorOf("Alt-Mod-f"));
    expect(acceleratorOf("Mod-Alt-f")).toBe("option+command+f");
  });

  test("names the keys that have names", () => {
    expect(acceleratorOf("Mod-Enter")).toBe("command+return");
    expect(acceleratorOf("Mod-Backspace")).toBe("command+backspace");
  });

  test("refuses a chord it cannot spell rather than guessing", () => {
    // An accelerator the parser does not understand is a key equivalent that
    // silently never fires; an item with no shortcut at least tells the truth.
    expect(acceleratorOf("Ctrl-Tab")).toBeNull();
    expect(acceleratorOf("F3")).toBeNull();
    expect(acceleratorOf("Shift-F3")).toBeNull();
  });
});
