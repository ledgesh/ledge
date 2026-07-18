import { describe, expect, test } from "bun:test";
import { initialState, reducer, type Action, type AppState } from "@/workspace/store";
import { buildCommands, paletteItems } from "./registry";
import { parseKey, resolveChord, DEFAULT_DOMAINS, type FocusDomain } from "./keymap";
import type { Command, CommandCtx, RegistryDeps } from "./types";

// Stub deps: the registry never touches the editor stack or the clipboard in
// tests; we only record that the right edge was invoked. `noteHead` is what a
// focused note's editor would hold — settable so the frontmatter-driven
// commands (profile.open) can be steered per test.
function stubDeps(calls: string[] = [], noteHead: string | null = null): RegistryDeps {
  const record = (name: string) => (arg: string) => calls.push(`${name}:${arg}`);
  return {
    copyText: record("copyText"),
    openSettings: () => calls.push("openSettings"),
    installCli: async () => {
      calls.push("installCli");
      return { ok: true, message: "installed" };
    },
    createWorkspace: async () => {
      calls.push("createWorkspace");
      return null;
    },
    attachWorkspace: async () => {
      calls.push("attachWorkspace");
      return null;
    },
    closeWorkspace: (id) => calls.push(`closeWorkspace:${id}`),
    restartSession: record("restartSession"),
    noteHead: () => noteHead,
    editor: {
      find: record("find"),
      replace: record("replace"),
      save: record("save"),
      runInline: record("runInline"),
      runInTerminal: record("runInTerminal"),
      openLink: record("openLink"),
      toggleTask: record("toggleTask"),
    },
  };
}

function makeCtx(state: AppState, dispatched: Action[] = []): CommandCtx {
  return {
    state,
    selected: state.workspaces.find((w) => w.id === state.selectedId) ?? state.workspaces[0]!,
    dispatch: (a) => dispatched.push(a),
    ui: {},
  };
}

function apply(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

// Notes are per workspace folder now; every test state's first workspace sits
// on FOLDER, and a second workspace (where needed) on its own folder.
const FOLDER = "/ws/notes";
const secondWs: Action = { type: "addWorkspace", name: "Workspace 2", folder: "/ws/two" };

const note = (path: string, title: string) => ({ path, title, mtimeMs: 0 });

function find(commands: Command[], id: string): Command {
  const cmd = commands.find((c) => c.id === id);
  if (!cmd) throw new Error(`no command ${id}`);
  return cmd;
}

describe("registry", () => {
  const commands = buildCommands(stubDeps());

  test("no two commands claim the same chord in an overlapping domain", () => {
    const seen = new Map<string, string>();
    for (const c of commands) {
      const domains = c.domains ?? DEFAULT_DOMAINS;
      for (const key of c.keys ?? []) {
        const k = parseKey(key);
        const norm = `${k.ctrl}|${k.alt}|${k.shift}|${k.meta}|${k.key}`;
        for (const d of domains) {
          const slot = `${d}:${norm}`;
          expect(`${slot}→${seen.get(slot) ?? ""}`).toBe(`${slot}→`);
          seen.set(slot, c.id);
        }
      }
    }
  });

  test("no two commands claim the same row verb on the same row kind", () => {
    // `r` may mean Rename on a workspace and Restore on a trashed note; it may
    // not mean two things on one row. This is the check that keeps the bare
    // keys unambiguous as commands are added (docs/interactions.md §2).
    const seen = new Map<string, string>();
    for (const c of commands) {
      for (const key of c.listKeys ?? []) {
        const slot = `${c.targetKind ?? "-"}:${key}`;
        expect(`${slot}→${seen.get(slot) ?? ""}`).toBe(`${slot}→`);
        seen.set(slot, c.id);
      }
    }
  });

  test("every row verb declares the row kind it acts on", () => {
    // Without a targetKind a bare key would fire on any focused row, which is
    // how `d` on a workspace ends up deleting a note.
    for (const c of commands) {
      if (c.listKeys?.length) expect({ id: c.id, targetKind: c.targetKind }).toMatchObject({
        targetKind: expect.any(String),
      });
    }
  });

  test("enablement: workspace.close needs a second workspace", () => {
    const one = initialState(FOLDER, []);
    expect(find(commands, "workspace.close").when!(makeCtx(one))).toBe(false);
    const two = apply(one, secondWs);
    expect(find(commands, "workspace.close").when!(makeCtx(two))).toBe(true);
  });

  test("enablement: pane.close needs a second pane", () => {
    const one = initialState(FOLDER, []);
    expect(find(commands, "pane.close").when!(makeCtx(one))).toBe(false);
    const split = apply(one, { type: "splitPane", dir: "row" });
    expect(find(commands, "pane.close").when!(makeCtx(split))).toBe(true);
  });

  test("enablement: tab cycling and indexed jumps track the focused pane's tabs", () => {
    const one = initialState(FOLDER, []);
    expect(find(commands, "tab.next").when!(makeCtx(one))).toBe(false);
    expect(find(commands, "tab.select.2").when!(makeCtx(one))).toBe(false);
    const two = apply(one, { type: "newTab" });
    expect(find(commands, "tab.next").when!(makeCtx(two))).toBe(true);
    expect(find(commands, "tab.select.2").when!(makeCtx(two))).toBe(true);
    expect(find(commands, "tab.select.3").when!(makeCtx(two))).toBe(false);
  });

  test("enablement: note.deleteCurrent needs a saved focused note", () => {
    // The initial demo tab has no file on disk: nothing to delete.
    const scratch = initialState(FOLDER, []);
    expect(find(commands, "note.deleteCurrent").when!(makeCtx(scratch))).toBe(false);
    const n = note("/tmp/a.md", "A");
    const withNote = apply(initialState(FOLDER, [n]), { type: "openNote", note: n });
    expect(find(commands, "note.deleteCurrent").when!(makeCtx(withNote))).toBe(true);
  });

  test("enablement: trash.empty follows the trash count", () => {
    expect(find(commands, "trash.empty").when!(makeCtx(initialState(FOLDER, [])))).toBe(false);
    const trashed = initialState(FOLDER, [], [{ path: "/t/a.md", title: "A", deletedAt: 0 }]);
    expect(find(commands, "trash.empty").when!(makeCtx(trashed))).toBe(true);
  });

  test("run: tab.close closes the focused pane's active tab", () => {
    const state = apply(initialState(FOLDER, []), { type: "newTab" });
    const dispatched: Action[] = [];
    const ctx = makeCtx(state, dispatched);
    find(commands, "tab.close").run(ctx);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe("closeTab");
  });

  test("run: tab.close honors an explicit tab target", () => {
    const state = apply(initialState(FOLDER, []), { type: "newTab" });
    const leaf = state.workspaces[0]!.root;
    if (leaf.kind !== "leaf") throw new Error("expected leaf");
    const dispatched: Action[] = [];
    const ctx = { ...makeCtx(state, dispatched), target: { kind: "tab", paneId: leaf.id, tabId: leaf.tabs[0]!.id } as const };
    find(commands, "tab.close").run(ctx);
    expect(dispatched[0]).toEqual({ type: "closeTab", paneId: leaf.id, tabId: leaf.tabs[0]!.id });
  });

  test("run: tab.next wraps around", () => {
    const state = apply(initialState(FOLDER, []), { type: "newTab" }); // 2 tabs, second active
    const dispatched: Action[] = [];
    find(commands, "tab.next").run(makeCtx(state, dispatched));
    const leaf = state.workspaces[0]!.root;
    if (leaf.kind !== "leaf") throw new Error("expected leaf");
    // Active is the second (just-created) tab; next wraps to the first.
    expect(dispatched[0]).toEqual({ type: "selectTab", paneId: leaf.id, tabId: leaf.tabs[0]!.id });
  });

  test("run: editor commands route through deps with the focused docId", () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const state = initialState(FOLDER, []);
    const leaf = state.workspaces[0]!.root;
    if (leaf.kind !== "leaf") throw new Error("expected leaf");
    const docId = leaf.tabs[0]!.docId;
    find(cmds, "editor.find").run(makeCtx(state));
    find(cmds, "block.runInline").run(makeCtx(state));
    expect(calls).toEqual([`find:${docId}`, `runInline:${docId}`]);
  });

  test("run: settings.open routes to the openSettings edge", () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    find(cmds, "settings.open").run(makeCtx(initialState(FOLDER, [])));
    expect(calls).toEqual(["openSettings"]);
  });

  test("run: cli.install routes to the installCli edge and surfaces the outcome", async () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const notices: string[] = [];
    const ctx = makeCtx(initialState(FOLDER, []));
    ctx.ui.showNotice = (m) => notices.push(m);
    find(cmds, "cli.install").run(ctx);
    await Bun.sleep(0); // the run fires and forgets; the surface lands a microtask later
    expect(calls).toEqual(["installCli"]);
    expect(notices).toEqual(["installed"]);
  });

  test("run: session.restart routes the focused docId to the restart edge", () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const state = initialState(FOLDER, []);
    const leaf = state.workspaces[0]!.root;
    if (leaf.kind !== "leaf") throw new Error("expected leaf");
    find(cmds, "session.restart").run(makeCtx(state));
    expect(calls).toEqual([`restartSession:${leaf.tabs[0]!.docId}`]);
  });

  test("run: workspace commands route through the action deps, not the reducer", () => {
    // Creating and attaching need a Bun round trip (folder, native dialog);
    // closing must detach the folder after the reducer closes the view. All
    // three go through deps so the registry stays pure.
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const state = apply(initialState(FOLDER, []), secondWs);
    find(cmds, "workspace.new").run(makeCtx(state));
    find(cmds, "workspace.attach").run(makeCtx(state));
    find(cmds, "workspace.close").run(makeCtx(state));
    expect(calls).toEqual(["createWorkspace", "attachWorkspace", `closeWorkspace:${state.selectedId}`]);
  });

  test("profile.open follows the current note's frontmatter, and only that", () => {
    // The command is the editing arm of `profile: name`: with a profile named
    // it opens the editor dialog on exactly that one, and with none it is
    // hidden — prompting for a name here would invent a second way to say
    // what the frontmatter already says.
    const opened: string[] = [];
    const withProfile = buildCommands(stubDeps([], "---\nprofile: petstore\n---\n# T\n"));
    const ctx = { ...makeCtx(initialState(FOLDER, [])), ui: { openProfileEditor: (n: string) => opened.push(n) } };
    expect(find(withProfile, "profile.open").when!(ctx)).toBe(true);
    find(withProfile, "profile.open").run(ctx);
    expect(opened).toEqual(["petstore"]);

    const withoutProfile = buildCommands(stubDeps([], "# Plain note\n"));
    expect(find(withoutProfile, "profile.open").when!(ctx)).toBe(false);

    const noEditor = buildCommands(stubDeps([], null));
    expect(find(noEditor, "profile.open").when!(ctx)).toBe(false);
  });

  test("run: note.copyPath copies the targeted row's path", () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const ctx = { ...makeCtx(initialState(FOLDER, [])), target: { kind: "note", path: "/n/a.md" } as const };
    find(cmds, "note.copyPath").run(ctx);
    expect(calls).toEqual(["copyText:/n/a.md"]);
  });

  test("run: row verbs act on their row, not on the current note", () => {
    // The note open in the editor is A; the focused row is B. `d` on B must
    // trash B — a row verb that quietly acted on the current note would be a
    // data-loss bug, not a UX one.
    const a = note("/n/a.md", "A");
    const b = note("/n/b.md", "B");
    const state = apply(initialState(FOLDER, [a, b]), { type: "openNote", note: a });
    const deleted: string[] = [];
    const ctx: CommandCtx = {
      ...makeCtx(state),
      ui: { deleteNoteWithUndo: (n) => deleted.push(n.path) },
      target: { kind: "note", path: b.path },
    };
    find(commands, "note.delete").run(ctx);
    find(commands, "note.deleteCurrent").run(ctx); // ⌘⌫ on a focused row: same row
    expect(deleted).toEqual([b.path, b.path]);
  });

  test("run: note.open opens the targeted row's note", () => {
    const n = note("/n/a.md", "A");
    const dispatched: Action[] = [];
    const ctx: CommandCtx = {
      ...makeCtx(initialState(FOLDER, [n]), dispatched),
      target: { kind: "note", path: n.path },
    };
    find(commands, "note.open").run(ctx);
    expect(dispatched).toEqual([{ type: "openNote", note: n }]);
  });

  test("run: trash rows restore and confirm-delete the targeted item", () => {
    const item = { path: "/t/a.md", title: "A", deletedAt: 0 };
    const restored: string[] = [];
    const confirmed: string[] = [];
    const ctx: CommandCtx = {
      ...makeCtx(initialState(FOLDER, [], [item])),
      ui: {
        restoreTrashed: (p) => restored.push(p),
        confirmDeleteTrashed: (i) => confirmed.push(i.path),
      },
      target: { kind: "trash", path: item.path },
    };
    find(commands, "note.restore").run(ctx);
    find(commands, "trash.delete").run(ctx);
    expect(restored).toEqual([item.path]);
    // Permanent delete confirms rather than acting: it is irreversible.
    expect(confirmed).toEqual([item.path]);
  });

  test("note verbs refuse a trash target", () => {
    // Both kinds carry a path; only the kind keeps Delete off a trashed note.
    const ctx: CommandCtx = {
      ...makeCtx(initialState(FOLDER, [], [{ path: "/t/a.md", title: "A", deletedAt: 0 }])),
      target: { kind: "trash", path: "/t/a.md" },
    };
    expect(find(commands, "note.delete").when!(ctx)).toBe(false);
    expect(find(commands, "note.deleteCurrent").when!(ctx)).toBe(false);
    expect(find(commands, "note.open").when!(ctx)).toBe(false);
  });

  test("dispatch: bare row verbs resolve per row kind, and only in the list domain", () => {
    const d = { key: "d", meta: false, ctrl: false, alt: false, shift: false };
    const r = { key: "r", meta: false, ctrl: false, alt: false, shift: false };
    expect(
      resolveChord(commands, d, { domain: "list", modalOpen: false, targetKind: "note" })?.id,
    ).toBe("note.delete");
    expect(
      resolveChord(commands, d, { domain: "list", modalOpen: false, targetKind: "trash" })?.id,
    ).toBe("trash.delete");
    expect(
      resolveChord(commands, r, { domain: "list", modalOpen: false, targetKind: "workspace" })?.id,
    ).toBe("workspace.rename");
    expect(
      resolveChord(commands, r, { domain: "list", modalOpen: false, targetKind: "trash" })?.id,
    ).toBe("note.restore");
    // ⌘D stays the split key even with a row focused.
    const cmdD = { key: "d", meta: true, ctrl: false, alt: false, shift: false };
    expect(
      resolveChord(commands, cmdD, { domain: "list", modalOpen: false, targetKind: "note" })?.id,
    ).toBe("pane.splitRight");
    // And a bare `d` while typing in the editor is just a `d`.
    expect(resolveChord(commands, d, { domain: "editor", modalOpen: false })).toBeNull();
  });

  test("dynamic titles: workspace.select names the workspace", () => {
    const state = initialState(FOLDER, []);
    const title = find(commands, "workspace.select.1").title;
    expect(typeof title).toBe("function");
    expect((title as (c: CommandCtx) => string)(makeCtx(state))).toBe(
      `Switch to Workspace: ${state.workspaces[0]!.name}`,
    );
  });

  test("palette: hides when-false and palette:false, resolves titles and chips", () => {
    const state = initialState(FOLDER, []);
    const items = paletteItems(commands, makeCtx(state));
    const ids = items.map((i) => i.id);
    expect(ids).toContain("note.new");
    expect(ids).toContain("workspace.select.1");
    expect(ids).not.toContain("workspace.select.2"); // only one workspace
    expect(ids).not.toContain("workspace.close"); // when-false
    expect(ids).not.toContain("tab.select.1"); // palette: false
    expect(ids).not.toContain("note.delete"); // menu-only form
    const newNote = items.find((i) => i.id === "note.new")!;
    expect(newNote.title).toBe("New Note");
    expect(newNote.chip).toBe("⌘N");
  });

  test("dispatch: ⌘W resolves tab.close in every domain, ⌃1 not in terminal", () => {
    const cmdW = { key: "w", meta: true, ctrl: false, alt: false, shift: false };
    const ctrl1 = { key: "1", meta: false, ctrl: true, alt: false, shift: false };
    for (const domain of ["page", "editor", "terminal"] as FocusDomain[]) {
      expect(resolveChord(commands, cmdW, { domain, modalOpen: false })?.id).toBe("tab.close");
    }
    expect(resolveChord(commands, ctrl1, { domain: "editor", modalOpen: false })?.id).toBe("tab.select.1");
    expect(resolveChord(commands, ctrl1, { domain: "terminal", modalOpen: false })).toBeNull();
  });

  test("dispatch: editor-internal keys are never window-dispatched", () => {
    const cmdF = { key: "f", meta: true, ctrl: false, alt: false, shift: false };
    for (const domain of ["page", "editor", "terminal"] as FocusDomain[]) {
      expect(resolveChord(commands, cmdF, { domain, modalOpen: false })).toBeNull();
    }
  });
});
