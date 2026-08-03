import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { initialState, reducer, type Action, type AppState } from "@/workspace/store";
import { buildCommands, paletteItems } from "./registry";
import { parseKey, resolveChord, DEFAULT_DOMAINS, type FocusDomain } from "./keymap";
import type { Command, CommandCtx, RegistryDeps } from "./types";
import { configureShell, recordServerCaps } from "@/lib/shell";

// Stub deps: the registry never touches the editor stack or the clipboard in
// tests; we only record that the right edge was invoked. `noteHead` is what a
// focused note's editor would hold — settable so the frontmatter-driven
// commands (profile.open) can be steered per test. `dailyRoot` is the
// boot-resolved daily.workspace mirror the Edit/New Daily Template faces read.
function stubDeps(
  calls: string[] = [],
  noteHead: string | null = null,
  dailyRoot: string | null = null,
): RegistryDeps {
  const record = (name: string) => (arg: string) => calls.push(`${name}:${arg}`);
  return {
    copyText: record("copyText"),
    installCli: async () => {
      calls.push("installCli");
      return { ok: true, message: "installed" };
    },
    revealLog: () => calls.push("revealLog"),
    createWorkspace: async () => {
      calls.push("createWorkspace");
      return null;
    },
    attachWorkspace: async () => {
      calls.push("attachWorkspace");
      return null;
    },
    closeWorkspace: (id) => calls.push(`closeWorkspace:${id}`),
    moveWorkspace: async (id, _state, _dispatch, home) => {
      calls.push(`moveWorkspace:${id}${home ? ":home" : ""}`);
      return null;
    },
    workspaceKind: () => "external",
    docsFolder: () => null,
    openDocs: async (_state, _dispatch, page) => {
      calls.push(page ? `openDocs:${page}` : "openDocs");
    },
    closeDocs: () => calls.push("closeDocs"),
    restartSession: record("restartSession"),
    openDailyNote: async (folder) => {
      calls.push(`openDailyNote:${folder}`);
      return null;
    },
    newNoteFromTemplate: async (folder, templatePath) => {
      calls.push(`newNoteFromTemplate:${folder}:${templatePath}`);
      return { path: `${folder}/untitled.md`, title: "Untitled", mtimeMs: 0 };
    },
    createNote: async (folder, text) => {
      calls.push(`createNote:${folder}:${text.split("\n", 4).join("|")}`);
      return { path: `${folder}/untitled-template.md`, title: "Untitled Template", mtimeMs: 0 };
    },
    dailyRoot: () => dailyRoot,
    // The vault stub: state is "unlocked" so the lock verbs run their direct
    // path in tests (the dialog path is component-owned and e2e's business).
    vaultState: () => "unlocked",
    lockVaultNow: () => {
      calls.push("lockVaultNow");
    },
    lockNoteNow: async (folder, path) => {
      calls.push(`lockNoteNow:${folder}:${path}`);
      return { error: null, notice: null };
    },
    removeLockNow: async (folder, path) => {
      calls.push(`removeLockNow:${folder}:${path}`);
      return null;
    },
    openNoteIn: (root, note) => calls.push(`openNoteIn:${root}:${note.path}`),
    revealBacklink: (path, line, raw) => calls.push(`revealBacklink:${path}:${line}:${raw}`),
    jumpToHeading: (docId, line, text) => calls.push(`jumpToHeading:${docId}:${line}:${text}`),
    noteHead: () => noteHead,
    editor: {
      find: record("find"),
      replace: record("replace"),
      save: record("save"),
      runInline: record("runInline"),
      runInTerminal: record("runInTerminal"),
      openLink: record("openLink"),
      toggleTask: record("toggleTask"),
      bold: record("bold"),
      italic: record("italic"),
      insertLink: record("insertLink"),
      indent: record("indent"),
      outdent: record("outdent"),
      wikiLink: record("wikiLink"),
      insertImage: record("insertImage"),
      toggleTemplate: record("toggleTemplate"),
      editFrontmatter: record("editFrontmatter"),
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
    // keys unambiguous as commands are added (interactions.md §2).
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

  // interactions.md §1a, made a test rather than a paragraph (testing.md §3).
  // A touch client has exactly two general surfaces — the palette, reached
  // from the chrome control, and the row menus, reached by a long press — so a
  // command that is in neither has to be reachable by tapping something, and
  // if it is not, it does not exist on a phone at all.
  //
  // The exceptions are listed rather than inferred: a `palette: false` command
  // with no menu item and no tap is exactly the bug this catches, and a
  // regex over ids would hide it.
  const TAPPED: Record<string, string> = {
    "palette.commands":
      "the overlay's `>` crossing, inside the overlay the chrome's own control opens",
    "workspace.open": "tapping a workspace row IS switching to it",
    "terminal.close": "the drawer's ✕, plus Toggle Terminal in the palette",
    "tag.open": "tapping a tag row drills into it",
  };
  // ⌃1…9 by tab index: the tab itself is the affordance and the chord is only
  // its accelerator, so there are nine of these and one reason.
  const TAB_INDEX = /^tab\.select\.[1-9]$/;

  test("every command is reachable without a keyboard", () => {
    // Which commands a menu carries, read off the components that render them
    // — the registry cannot know, since a menu is JSX.
    const inAMenu = new Set<string>();
    for (const file of readdirSync("src/mainview", { recursive: true })) {
      if (typeof file !== "string" || !file.endsWith(".tsx")) continue;
      const source = readFileSync(`src/mainview/${file}`, "utf8");
      for (const item of source.match(/<CommandMenuItem[\s\S]*?\/>/g) ?? [])
        for (const id of item.match(/"[\w.]+"/g) ?? []) inAMenu.add(id.slice(1, -1));
    }

    const unreachable = commands
      .filter((c) => c.palette === false && !inAMenu.has(c.id) && !TAB_INDEX.test(c.id))
      .map((c) => c.id)
      .filter((id) => !(id in TAPPED));
    expect(unreachable).toEqual([]);

    // And the list stays honest: an entry that a menu item has since made
    // unnecessary is removed, not left to accumulate.
    const covered = Object.keys(TAPPED).filter(
      (id) => !commands.some((c) => c.id === id) || inAMenu.has(id),
    );
    expect(covered).toEqual([]);
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
    find(cmds, "format.bold").run(makeCtx(state));
    expect(calls).toEqual([`find:${docId}`, `runInline:${docId}`, `bold:${docId}`]);
  });

  test("run: settings.open opens the in-app settings editor dialog", () => {
    const opens: number[] = [];
    const ctx = makeCtx(initialState(FOLDER, []));
    ctx.ui = { openSettingsEditor: () => opens.push(1) };
    const cmds = buildCommands(stubDeps());
    find(cmds, "settings.open").run(ctx);
    expect(opens).toHaveLength(1);
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

  test("run: daily.open routes the selected folder to the daily edge", async () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    find(cmds, "daily.open").run(makeCtx(initialState(FOLDER, [])));
    await Bun.sleep(0);
    expect(calls).toEqual([`openDailyNote:${FOLDER}`]);
    // No openNote dispatch here: the open rides the external-open subscriber.
  });

  test("note.fromTemplate pre-filters to the entries — or to the starter when none exist", () => {
    const marked = { ...note(`${FOLDER}/meeting.md`, "Meeting"), template: true as const };
    const overlays: string[] = [];
    const ui = { openOverlay: (mode: string, q?: string) => overlays.push(`${mode}:${q ?? ""}`) };
    const parent = find(commands, "note.fromTemplate");
    // Visible in every ordinary workspace, templates or none: discoverability
    // is the point of the empty state. (The one gate is the read-only docs
    // workspace, pinned in the docs suite below.)
    expect(parent.when!(makeCtx(initialState(FOLDER, [])))).toBe(true);
    parent.run({ ...makeCtx(initialState(FOLDER, [marked])), ui });
    parent.run({ ...makeCtx(initialState(FOLDER, [note(`${FOLDER}/a.md`, "A")])), ui });
    expect(overlays).toEqual([
      "commands:New Note from Template: ",
      "commands:New Template",
    ]);
  });

  test("the template entries are LIVE state, not a boot snapshot", async () => {
    // The same built commands see different rows as the note lists change —
    // that is what makes "mark a note, use it" work without a relaunch.
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const entry = find(cmds, "note.fromTemplate.0");
    const none = makeCtx(initialState(FOLDER, [note(`${FOLDER}/plain.md`, "Plain")]));
    expect(entry.when!(none)).toBe(false);

    const marked = { ...note(`${FOLDER}/meeting.md`, "Meeting"), template: true as const };
    const dispatched: Action[] = [];
    const ctx = makeCtx(initialState(FOLDER, [marked]), dispatched);
    expect(entry.when!(ctx)).toBe(true);
    expect((entry.title as (c: CommandCtx) => string)(ctx)).toBe("New Note from Template: Meeting");
    entry.run(ctx);
    await Bun.sleep(0);
    // The pick hands over the PATH — the concrete note, not a re-resolvable name.
    expect(calls).toEqual([`newNoteFromTemplate:${FOLDER}:${marked.path}`]);
    expect(dispatched).toEqual([
      { type: "openNote", note: { path: `${FOLDER}/untitled.md`, title: "Untitled", mtimeMs: 0 } },
    ]);
  });

  test("another workspace's template follows the selected one's, naming its home", () => {
    const mine = { ...note(`${FOLDER}/zeta.md`, "Zeta"), template: true as const };
    const theirs = { ...note("/ws/two/meeting.md", "Meeting"), template: true as const };
    const state = apply(initialState(FOLDER, [mine]), secondWs, {
      type: "notesLoaded",
      folder: "/ws/two",
      notes: [theirs],
    });
    // Selected is workspace 2 after addWorkspace; its own Meeting leads,
    // the first workspace's Zeta trails with the workspace name attached.
    const ctx = makeCtx(state);
    const titleOfSlot = (i: number) =>
      (find(commands, `note.fromTemplate.${i}`).title as (c: CommandCtx) => string)(ctx);
    expect(titleOfSlot(0)).toBe("New Note from Template: Meeting");
    expect(titleOfSlot(1)).toBe(`New Note from Template: Zeta (${state.workspaces[0]!.name})`);
    expect(find(commands, "note.fromTemplate.2").when!(ctx)).toBe(false);
  });

  test("template.starter creates the marked cheatsheet and opens it", async () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const dispatched: Action[] = [];
    find(cmds, "template.starter").run(makeCtx(initialState(FOLDER, []), dispatched));
    await Bun.sleep(0);
    // Born marked: the starter must appear in the picker it teaches about.
    expect(calls).toEqual([`createNote:${FOLDER}:---|template: true|---|# Untitled Template`]);
    expect(dispatched).toEqual([
      { type: "openNote", note: { path: `${FOLDER}/untitled-template.md`, title: "Untitled Template", mtimeMs: 0 } },
    ]);
  });

  test("the marker verbs follow the current note's frontmatter, one at a time", () => {
    const state = initialState(FOLDER, []);
    const docId = state.workspaces[0]!.root.kind === "leaf" ? state.workspaces[0]!.root.tabs[0]!.docId : "";
    const calls: string[] = [];
    const unmarked = buildCommands(stubDeps(calls, "# Plain note\n"));
    const ctx = makeCtx(state);
    expect(find(unmarked, "note.templateOn").when!(ctx)).toBe(true);
    expect(find(unmarked, "note.templateOff").when!(ctx)).toBe(false);
    find(unmarked, "note.templateOn").run(ctx);
    expect(calls).toEqual([`toggleTemplate:${docId}`]);

    const marked = buildCommands(stubDeps([], "---\ntemplate: true\n---\n# T\n"));
    expect(find(marked, "note.templateOn").when!(ctx)).toBe(false);
    expect(find(marked, "note.templateOff").when!(ctx)).toBe(true);

    // No live editor for the doc: neither verb shows.
    const noEditor = buildCommands(stubDeps([], null));
    expect(find(noEditor, "note.templateOn").when!(ctx)).toBe(false);
    expect(find(noEditor, "note.templateOff").when!(ctx)).toBe(false);
  });

  test("the daily-template verbs: one face at a time, acting in the selected workspace by default", async () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    // No claimant anywhere: only New shows, and it creates the pre-marked
    // starter in the selected workspace, opening it through the external-open
    // edge (the daily workspace need not be the selected one in general).
    const bare = makeCtx(initialState(FOLDER, [note(`${FOLDER}/plain.md`, "Plain")]));
    expect(find(cmds, "daily.templateEdit").when!(bare)).toBe(false);
    expect(find(cmds, "daily.templateNew").when!(bare)).toBe(true);
    find(cmds, "daily.templateNew").run(bare);
    await Bun.sleep(0);
    expect(calls).toEqual([
      `createNote:${FOLDER}:---|template: daily|---|# Daily Template`,
      `openNoteIn:${FOLDER}:${FOLDER}/untitled-template.md`,
    ]);

    // A claimant flips the faces; a plain template: true note does not.
    calls.length = 0;
    const daily = { ...note(`${FOLDER}/daily.md`, "Daily Template"), template: "daily" as const };
    const plain = { ...note(`${FOLDER}/meeting.md`, "Meeting"), template: true as const };
    const claimed = makeCtx(initialState(FOLDER, [plain, daily]));
    expect(find(cmds, "daily.templateEdit").when!(claimed)).toBe(true);
    expect(find(cmds, "daily.templateNew").when!(claimed)).toBe(false);
    find(cmds, "daily.templateEdit").run(claimed);
    expect(calls).toEqual([`openNoteIn:${FOLDER}:${daily.path}`]);
  });

  test("the daily-template verbs follow a pinned daily.workspace, not the selection", () => {
    // daily.workspace resolved to the FIRST workspace at boot; workspace 2 is
    // selected. The verbs must look (and act) where ⌘J will: the pinned root.
    const calls: string[] = [];
    const pinned = buildCommands(stubDeps(calls, null, FOLDER));
    const daily = { ...note(`${FOLDER}/daily.md`, "Daily Template"), template: "daily" as const };
    const state = apply(initialState(FOLDER, [daily]), secondWs, {
      type: "notesLoaded",
      folder: "/ws/two",
      notes: [{ ...note("/ws/two/theirs.md", "Theirs"), template: "daily" as const }],
    });
    const ctx = makeCtx(state); // selected is workspace 2 after addWorkspace
    expect(ctx.selected.folder).toBe("/ws/two");
    expect(find(pinned, "daily.templateEdit").when!(ctx)).toBe(true);
    find(pinned, "daily.templateEdit").run(ctx);
    expect(calls).toEqual([`openNoteIn:${FOLDER}:${daily.path}`]);
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

  test("workspace.move forks on kind: managed goes straight to the move action, external stops at the chooser", async () => {
    // A managed folder's only destination question is "where?", which the
    // native picker answers; an external folder gets the in-app chooser first
    // (its natural destination, back under hidden ~/.ledge, is one the native
    // dialog cannot offer), and the dialog owns whatever happens next.
    const managedCalls: string[] = [];
    const state = initialState(FOLDER, []);
    const managed = buildCommands({ ...stubDeps(managedCalls), workspaceKind: () => "managed" });
    find(managed, "workspace.move").run(makeCtx(state));
    await Promise.resolve();
    expect(managedCalls).toEqual([`moveWorkspace:${state.selectedId}`]);

    const externalCalls: string[] = [];
    const external = buildCommands(stubDeps(externalCalls)); // stub kind: external
    const picked: string[] = [];
    const ctx = makeCtx(state);
    ctx.ui = { pickMoveDestination: (id: string) => picked.push(id) };
    find(external, "workspace.move").run(ctx);
    expect(picked).toEqual([state.selectedId]);
    expect(externalCalls).toEqual([]);
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

  test("frontmatter.edit: the title says what will happen, the run routes the focused doc", () => {
    // One command with a live title (not the two-faces move): it holds a
    // chord, and the dispatcher ignores `when`, so a second command on ⌥⌘,
    // could never fire.
    const state = initialState(FOLDER, []);
    const docId = state.workspaces[0]!.root.kind === "leaf" ? state.workspaces[0]!.root.tabs[0]!.docId : "";
    const ctx = makeCtx(state);
    const calls: string[] = [];
    const without = buildCommands(stubDeps(calls, "# Plain note\n"));
    const title = (cmds: Command[]) =>
      (find(cmds, "frontmatter.edit").title as (c: CommandCtx) => string)(ctx);
    expect(title(without)).toBe("Add Frontmatter");
    expect(find(without, "frontmatter.edit").when!(ctx)).toBe(true);
    find(without, "frontmatter.edit").run(ctx);
    expect(calls).toEqual([`editFrontmatter:${docId}`]);

    const withBlock = buildCommands(stubDeps([], "---\ncwd: /x\n---\n# T\n"));
    expect(title(withBlock)).toBe("Edit Frontmatter");

    // No live editor for the doc: hidden, like the other frontmatter verbs.
    const noEditor = buildCommands(stubDeps([], null));
    expect(find(noEditor, "frontmatter.edit").when!(ctx)).toBe(false);
  });

  test("run: note.copyPath copies the targeted row's path", () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const ctx = { ...makeCtx(initialState(FOLDER, [])), target: { kind: "note", path: "/n/a.md" } as const };
    find(cmds, "note.copyPath").run(ctx);
    expect(calls).toEqual(["copyText:/n/a.md"]);
  });

  test("run: outline.jump routes its row through the jumpToHeading dep", () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const ctx = {
      ...makeCtx(initialState(FOLDER, [])),
      target: { kind: "heading", docId: "doc1", line: 7, text: "Setup" } as const,
    };
    find(cmds, "outline.jump").run(ctx);
    expect(calls).toEqual(["jumpToHeading:doc1:7:Setup"]);
  });

  test("run: tags.toggle and tag.open route through the ui hooks", () => {
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps());
    const ctx: CommandCtx = {
      ...makeCtx(initialState(FOLDER, [])),
      ui: {
        toggleTags: () => calls.push("toggleTags"),
        showTag: (tag: string) => calls.push(`showTag:${tag}`),
      },
    };
    find(cmds, "tags.toggle").run(ctx);
    find(cmds, "tag.open").run({ ...ctx, target: { kind: "tag", tag: "work" } });
    expect(calls).toEqual(["toggleTags", "showTag:work"]);
  });

  test("run: tag.openNote reveals before opening, and a vanished note is a no-op", () => {
    const n = note(`${FOLDER}/a.md`, "Alpha");
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const dispatched: Action[] = [];
    const ctx: CommandCtx = {
      ...makeCtx(initialState(FOLDER, [n]), dispatched),
      target: { kind: "tagnote", path: n.path, line: 4, raw: "#work" },
    };
    find(cmds, "tag.openNote").run(ctx);
    // backlink.open's contract: the reveal is registered BEFORE the open.
    expect(calls).toEqual([`revealBacklink:${n.path}:4:#work`]);
    expect(dispatched).toEqual([{ type: "openNote", note: n }]);

    find(cmds, "tag.openNote").run({
      ...ctx,
      target: { kind: "tagnote", path: "/gone.md", line: 1, raw: "#x" },
    });
    expect(dispatched).toHaveLength(1);
  });

  test("run: outline.copyLink copies [[Title#Heading]] — plain [[Title]] for the H1 itself", () => {
    // The focused tab is the initial demo tab, titled "Welcome"; a subheading
    // gets the anchored form, the H1 (its text IS the title) gets the plain
    // link — [[Welcome#Welcome]] would be a strange spelling of the note
    // itself.
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const ctx = makeCtx(initialState(FOLDER, []));
    const title = ctx.selected.root.kind === "leaf" ? ctx.selected.root.tabs[0]!.title : "";
    find(cmds, "outline.copyLink").run({
      ...ctx,
      target: { kind: "heading", docId: "doc1", line: 3, text: "Setup" } as const,
    });
    find(cmds, "outline.copyLink").run({
      ...ctx,
      target: { kind: "heading", docId: "doc1", line: 1, text: title } as const,
    });
    expect(calls).toEqual([`copyText:[[${title}#Setup]]`, `copyText:[[${title}]]`]);
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

  test("run: the lock faces act on their row, not on the current note", () => {
    // Same stance as the row verbs above: the sidebar menu's Lock This Note…
    // must lock the row's note even while a different note is focused — and
    // which face shows follows the TARGET's locked flag, not the focused one's.
    const a = note("/n/a.md", "A");
    const b = note("/n/b.md", "B");
    const sealed = { ...note("/n/s.md", "S"), locked: true };
    const state = apply(initialState(FOLDER, [a, b, sealed]), { type: "openNote", note: a });
    const calls: string[] = [];
    const cmds = buildCommands(stubDeps(calls));
    const confirmed: string[] = [];
    const onB: CommandCtx = {
      ...makeCtx(state),
      ui: { confirmRemoveLock: (n) => confirmed.push(n.path) },
      target: { kind: "note", path: b.path },
    };
    const onSealed: CommandCtx = { ...onB, target: { kind: "note", path: sealed.path } };
    expect(find(cmds, "note.lockOn").when!(onB)).toBe(true);
    expect(find(cmds, "note.lockOn").when!(onSealed)).toBe(false);
    expect(find(cmds, "note.lockOff").when!(onB)).toBe(false);
    expect(find(cmds, "note.lockOff").when!(onSealed)).toBe(true);
    // The vault stub is "unlocked", so both run their direct paths.
    find(cmds, "note.lockOn").run(onB);
    expect(calls).toEqual([`lockNoteNow:${FOLDER}:${b.path}`]);
    find(cmds, "note.lockOff").run(onSealed);
    expect(confirmed).toEqual([sealed.path]);
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
    expect(find(commands, "note.lockOn").when!(ctx)).toBe(false);
    expect(find(commands, "note.lockOff").when!(ctx)).toBe(false);
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

  // --- the docs workspace (read-only, hidden from the strip) ----------------

  const DOCS = "/docs/.ledge-docs";
  function docsDeps(calls: string[] = [], noteHead: string | null = null): RegistryDeps {
    return {
      ...stubDeps(calls, noteHead),
      workspaceKind: (folder) => (folder === DOCS ? "docs" : "external"),
      docsFolder: () => DOCS,
    };
  }
  // A state with the ordinary first workspace plus the docs one, SELECTED —
  // addWorkspace selects what it adds, which is exactly what openDocs does.
  const docsSelectedState = () =>
    apply(initialState(FOLDER, []), { type: "addWorkspace", name: "Documentation", folder: DOCS });

  test("docs.toggle shows only when a docs root exists, and routes to the openDocs edge", () => {
    // The base stub reports no docs root: hidden (a harness or failed boot).
    expect(find(commands, "docs.toggle").when!(makeCtx(initialState(FOLDER, [])))).toBe(false);
    const calls: string[] = [];
    const cmds = buildCommands(docsDeps(calls));
    const ctx = makeCtx(initialState(FOLDER, []));
    expect(find(cmds, "docs.toggle").when!(ctx)).toBe(true);
    find(cmds, "docs.toggle").run(ctx);
    expect(calls).toEqual(["openDocs"]);
  });

  // The other half, and the reason the command is a toggle at all: the docs
  // workspace is no strip row and no ⌘1…9 slot, so the surface that would
  // otherwise be the way back is one the manual itself is covering.
  test("docs.toggle closes the manual when the manual is what is selected", () => {
    const calls: string[] = [];
    const cmds = buildCommands(docsDeps(calls));
    find(cmds, "docs.toggle").run(makeCtx(docsSelectedState()));
    expect(calls).toEqual(["closeDocs"]);
  });

  // The licenses have to be reachable in the shipped app, not only in the
  // repository: the title it asks for is the H1 of the generated page
  // (bun/licenses.ts), and a rename on either side breaks the landing.
  test("docs.licenses opens the manual on the notices page", () => {
    const calls: string[] = [];
    const cmds = buildCommands(docsDeps(calls));
    const ctx = makeCtx(initialState(FOLDER, []));
    expect(find(cmds, "docs.licenses").when!(ctx)).toBe(true);
    find(cmds, "docs.licenses").run(ctx);
    expect(calls).toEqual(["openDocs:Third-Party Licenses"]);
    // Hidden with no docs root, same as docs.toggle: there is nothing to open.
    expect(find(commands, "docs.licenses").when!(makeCtx(initialState(FOLDER, [])))).toBe(false);
  });

  test("⌘N indexing skips the docs workspace", () => {
    const cmds = buildCommands(docsDeps());
    const ctx = makeCtx(docsSelectedState());
    // Slot 1 is the real workspace; there is no slot 2 — docs never counts.
    expect((find(cmds, "workspace.select.1").title as (c: CommandCtx) => string)(ctx)).toBe(
      `Switch to Workspace: ${ctx.state.workspaces[0]!.name}`,
    );
    expect(find(cmds, "workspace.select.2").when!(ctx)).toBe(false);
  });

  test("create and mutate verbs gate while the docs workspace is selected", () => {
    const cmds = buildCommands(docsDeps([], "# Getting Started\n"));
    const page = note(`${DOCS}/getting-started.md`, "Getting Started");
    const ctx: CommandCtx = {
      ...makeCtx(apply(docsSelectedState(), { type: "notesLoaded", folder: DOCS, notes: [page] })),
      target: { kind: "note", path: page.path },
    };
    expect(ctx.selected.folder).toBe(DOCS);
    for (const id of [
      "note.new",
      "note.fromTemplate",
      "template.starter",
      "note.templateOn",
      "note.delete",
      "note.deleteCurrent",
      "note.lockOn",
      "frontmatter.edit",
      "workspace.rename",
      "workspace.icon",
      "workspace.move",
    ]) {
      expect({ id, when: find(cmds, id).when!(ctx) }).toEqual({ id, when: false });
    }
    // Reading stays whole: the page opens like any note row.
    expect(find(cmds, "note.open").when!(ctx)).toBe(true);
  });

  test("⌘J in the docs workspace follows the pinned daily workspace, and gates without one", () => {
    const unpinned = buildCommands(docsDeps());
    expect(find(unpinned, "daily.open").when!(makeCtx(docsSelectedState()))).toBe(false);
    const pinned = buildCommands({ ...docsDeps(), dailyRoot: () => FOLDER });
    expect(find(pinned, "daily.open").when!(makeCtx(docsSelectedState()))).toBe(true);
  });

  test("splitting in the docs workspace opens an empty pane, not an unsavable scratch tab", () => {
    const cmds = buildCommands(docsDeps());
    // Splitting stays enabled there — reading two pages side by side is the
    // point of a second pane.
    for (const id of ["pane.splitRight", "pane.splitDown"]) {
      const docs: Action[] = [];
      find(cmds, id).run(makeCtx(docsSelectedState(), docs));
      expect(docs).toEqual([
        { type: "splitPane", dir: id === "pane.splitRight" ? "row" : "col", paneId: undefined, empty: true },
      ]);
      // A writable workspace still seeds: `empty` is the docs exception only.
      const real: Action[] = [];
      find(cmds, id).run(makeCtx(initialState(FOLDER, []), real));
      expect(real[0]).toMatchObject({ type: "splitPane", empty: false });
    }
  });

  test("closing workspaces around the docs one: docs closes freely, the last real one never", () => {
    const cmds = buildCommands(docsDeps());
    const state = docsSelectedState();
    const docsWs = state.workspaces.find((w) => w.folder === DOCS)!;
    const realWs = state.workspaces.find((w) => w.folder === FOLDER)!;
    const on = (id: string): CommandCtx => ({ ...makeCtx(state), target: { kind: "workspace", id } });
    expect(find(cmds, "workspace.close").when!(on(docsWs.id))).toBe(true);
    // The real workspace is the last visible one: closing it would strand the
    // user in a workspace with no strip row.
    expect(find(cmds, "workspace.close").when!(on(realWs.id))).toBe(false);
  });
});

// Two facts about the CLIENT rather than the target (lib/shell.ts), and the
// thing worth pinning is that they are two: the phase after v1 runs blocks on a
// phone that still has no terminal drawer (ios.md §14), and one boolean could
// not describe that client without either offering it a drawer it does not have
// or withholding the runs it does.
//
// Only `when` is read here. Nothing is deleted to achieve a cut — every command
// is still built and `run` still works — so a test that invoked them would be
// asking the wrong question.
describe("what this client has a surface for", () => {
  // Module state, so it is set for the `when` calls and put back after: every
  // other test in this file expects the desktop's answers.
  function shell(
    next: { runsBlocks: boolean; hasTerminal: boolean },
    check: (visible: (id: string) => boolean) => void,
  ): void {
    configureShell(next);
    try {
      const cmds = buildCommands(stubDeps([], "---\nprofile: petstore\n---\n# T\n"));
      const ctx = makeCtx(initialState(FOLDER, []));
      check((id) => find(cmds, id).when?.(ctx) ?? true);
    } finally {
      configureShell({ runsBlocks: true, hasTerminal: true });
    }
  }

  const RUNNING = ["block.runInline", "profile.open"];
  const DRAWER = ["block.runInTerminal", "terminal.toggle", "terminal.close"];
  // The id is in the assertion rather than the message so a failure names the
  // verb that went the wrong way.
  const shows = (visible: (id: string) => boolean, id: string, want: boolean) =>
    expect(`${id}:${visible(id)}`).toBe(`${id}:${want}`);

  test("the desktop has every one of them, which is the default a shell inherits", () => {
    shell({ runsBlocks: true, hasTerminal: true }, (visible) => {
      for (const id of [...RUNNING, ...DRAWER, "session.restart"]) shows(visible, id, true);
    });
  });

  test("v1 on a phone has neither, so no verb reaches a surface that is not built", () => {
    shell({ runsBlocks: false, hasTerminal: false }, (visible) => {
      for (const id of [...RUNNING, ...DRAWER, "session.restart"]) shows(visible, id, false);
    });
  });

  test("blocks without a drawer: the inline half stays, the drawer half goes", () => {
    // The configuration the split exists for. "Run Block in Terminal" is the
    // one verb that needs both answers — it takes a block out of the note and
    // puts it in a drawer — so it goes with the drawer, not with the runs.
    shell({ runsBlocks: true, hasTerminal: false }, (visible) => {
      for (const id of RUNNING) shows(visible, id, true);
      for (const id of DRAWER) shows(visible, id, false);
      // A note that runs blocks has a shell of its own, and this is the verb
      // that kills it.
      shows(visible, "session.restart", true);
    });
  });

  // The same cut one machine out: not what this client has a surface for but
  // what the machine holding the notes has at all. Both answers arrive together
  // on the boot handshake (workspaceList), and both are false on a headless
  // server whether a Mac or a phone is looking at it.
  function serverCaps(next: { folderDialog: boolean; cliShim: boolean }, check: (visible: (id: string) => boolean) => void): void {
    recordServerCaps(next);
    try {
      const cmds = buildCommands(stubDeps());
      const ctx = makeCtx(initialState(FOLDER, []));
      check((id) => find(cmds, id).when?.(ctx) ?? true);
    } finally {
      recordServerCaps({ folderDialog: true, cliShim: true });
    }
  }

  test("notes on this Mac: the verbs that write to the notes machine are all offered", () => {
    serverCaps({ folderDialog: true, cliShim: true }, (visible) => {
      for (const id of ["workspace.attach", "workspace.move", "cli.install"]) shows(visible, id, true);
    });
  });

  test("notes on a server: no dialog to open there, and no CLI to install there", () => {
    serverCaps({ folderDialog: false, cliShim: false }, (visible) => {
      for (const id of ["workspace.attach", "workspace.move", "cli.install"]) shows(visible, id, false);
    });
  });

  // Two facts, not one: a machine can have a person at it and still have
  // nothing to install, which is what a `bun src/bun/serve.ts` in a checkout is
  // (serve.fs.test.ts).
  test("the two server facts are independent", () => {
    serverCaps({ folderDialog: true, cliShim: false }, (visible) => {
      shows(visible, "workspace.attach", true);
      shows(visible, "cli.install", false);
    });
  });
});
