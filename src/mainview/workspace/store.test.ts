import { test, expect, describe } from "bun:test";
import { reducer, initialState, allDocIds, notesOf, openNotePaths, trashOf, type AppState, type Action } from "./store";
import { firstLeaf, leafIds, findLeaf, countTabs, focusedTab, type SplitNode } from "./tree";
import { DEFAULT_ICON } from "./icons";
import type { NoteMeta, TrashMeta } from "../../shared/rpc-schema";

// The folder every fresh test state's first workspace owns. Notes are local
// to a workspace folder now, so states are seeded per folder.
const FOLDER = "/ws/notes";

// An addWorkspace with a distinct folder per index: two adds with the SAME
// folder would select the existing workspace instead of appending (the
// one-workspace-per-folder rule, tested below).
const addWs = (n: number): Action => ({
  type: "addWorkspace",
  name: `Workspace ${n}`,
  folder: `/ws/extra-${n}`,
});

// Apply a sequence of actions from a fresh state.
function run(...actions: Action[]): AppState {
  return actions.reduce(reducer, initialState(FOLDER));
}

const selected = (s: AppState) => s.workspaces.find((w) => w.id === s.selectedId)!;

describe("initialState", () => {
  test("one workspace on the given folder, selected, with a single seeded tab", () => {
    const s = initialState(FOLDER);
    expect(s.workspaces).toHaveLength(1);
    expect(s.selectedId).toBe(s.workspaces[0].id);
    const ws = selected(s);
    expect(ws.folder).toBe(FOLDER);
    expect(leafIds(ws.root)).toHaveLength(1);
    expect(countTabs(ws.root)).toBe(1);
    expect(ws.focusedPaneId).toBe(firstLeaf(ws.root).id);
  });
});

describe("tabs", () => {
  test("newTab appends a tab to the focused pane and activates it", () => {
    const s = run({ type: "newTab" });
    const ws = selected(s);
    expect(countTabs(ws.root)).toBe(2);
    const leaf = firstLeaf(ws.root);
    expect(leaf.activeTabId).toBe(leaf.tabs[1].id); // the new one
    expect(ws.focusedPaneId).toBe(leaf.id); // still the same single pane
  });

  test("closeTab on the active middle tab falls to the tab that slid into its slot", () => {
    let s = run({ type: "newTab" }, { type: "newTab" }); // 3 tabs total
    const pane = firstLeaf(selected(s).root).id;
    const tabs = firstLeaf(selected(s).root).tabs;
    // Activate the middle tab, then close it.
    s = reducer(s, { type: "selectTab", paneId: pane, tabId: tabs[1].id });
    s = reducer(s, { type: "closeTab", paneId: pane, tabId: tabs[1].id });
    const leaf = firstLeaf(selected(s).root);
    expect(leaf.tabs.map((t) => t.id)).toEqual([tabs[0].id, tabs[2].id]);
    expect(leaf.activeTabId).toBe(tabs[2].id); // slid into index 1
  });

  test("closing the active last tab falls back to the previous tab", () => {
    let s = run({ type: "newTab" }); // 2 tabs; new one active (index 1)
    const leaf0 = firstLeaf(selected(s).root);
    s = reducer(s, { type: "closeTab", paneId: leaf0.id, tabId: leaf0.activeTabId });
    const leaf = firstLeaf(selected(s).root);
    expect(leaf.tabs.map((t) => t.id)).toEqual([leaf0.tabs[0].id]);
    expect(leaf.activeTabId).toBe(leaf0.tabs[0].id);
  });

  test("closing the only tab empties the pane (activeTabId becomes empty)", () => {
    const s0 = initialState(FOLDER);
    const leaf = firstLeaf(selected(s0).root);
    const s = reducer(s0, { type: "closeTab", paneId: leaf.id, tabId: leaf.activeTabId });
    const after = firstLeaf(selected(s).root);
    expect(after.tabs).toHaveLength(0);
    expect(after.activeTabId).toBe("");
  });
});

describe("moveTab", () => {
  test("reordering within a pane keeps focus and activates the moved tab", () => {
    let s = run({ type: "newTab" }, { type: "newTab" }); // 3 tabs, [0,1,2]
    const leaf = firstLeaf(selected(s).root);
    const ids = leaf.tabs.map((t) => t.id);
    s = reducer(s, { type: "moveTab", fromPaneId: leaf.id, tabId: ids[0], toPaneId: leaf.id, toIndex: 3 });
    const after = firstLeaf(selected(s).root);
    expect(after.tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(after.activeTabId).toBe(ids[0]);
    expect(selected(s).focusedPaneId).toBe(leaf.id);
  });

  test("moving a tab to another pane focuses the destination", () => {
    let s = run({ type: "splitPane", dir: "row" }); // panes A | B, focus on B
    const a = firstLeaf(selected(s).root);
    const b = findLeaf(selected(s).root, selected(s).focusedPaneId)!;
    // Focus A, then drag A's tab into B.
    s = reducer(s, { type: "focusPane", paneId: a.id });
    const tabId = a.tabs[0].id;
    s = reducer(s, { type: "moveTab", fromPaneId: a.id, tabId, toPaneId: b.id, toIndex: 0 });
    const destB = findLeaf(selected(s).root, b.id)!;
    expect(destB.tabs.some((t) => t.id === tabId)).toBe(true);
    expect(destB.activeTabId).toBe(tabId);
    expect(selected(s).focusedPaneId).toBe(b.id);
    expect(findLeaf(selected(s).root, a.id)!.tabs).toHaveLength(0);
  });

  test("a no-op move (dropped on its own slot) leaves the workspace untouched", () => {
    const s0 = run({ type: "newTab" });
    const leaf = firstLeaf(selected(s0).root);
    const s = reducer(s0, {
      type: "moveTab",
      fromPaneId: leaf.id,
      tabId: leaf.tabs[0].id,
      toPaneId: leaf.id,
      toIndex: 0,
    });
    expect(selected(s).root).toBe(selected(s0).root);
  });
});

describe("splits", () => {
  test("splitPane creates a split and focuses the new pane", () => {
    const s = run({ type: "splitPane", dir: "row" });
    const ws = selected(s);
    expect(ws.root.kind).toBe("split");
    const ids = leafIds(ws.root);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(ws.focusedPaneId);
    expect(ws.focusedPaneId).not.toBe(firstLeaf(ws.root).id); // the new (second) pane
  });

  test("an empty splitPane seeds no tab: the docs workspace has no new note", () => {
    const s = run({ type: "splitPane", dir: "row", empty: true });
    const ws = selected(s);
    const pane = findLeaf(ws.root, ws.focusedPaneId)!;
    expect(pane.tabs).toEqual([]);
    expect(pane.activeTabId).toBe("");
    // The pane still exists and holds focus, so the next note opened lands in it.
    expect(leafIds(ws.root)).toHaveLength(2);
  });

  test("closePane collapses back to the sibling and refocuses", () => {
    const s1 = run({ type: "splitPane", dir: "row" });
    const s2 = reducer(s1, { type: "closePane", paneId: selected(s1).focusedPaneId });
    const ws = selected(s2);
    expect(leafIds(ws.root)).toHaveLength(1);
    expect(ws.focusedPaneId).toBe(firstLeaf(ws.root).id);
  });

  test("closePane is a no-op when only one pane remains", () => {
    const s0 = initialState(FOLDER);
    const s = reducer(s0, { type: "closePane" });
    expect(selected(s).root).toBe(selected(s0).root);
  });

  test("setRatio is clamped to [0.12, 0.88]", () => {
    const s1 = run({ type: "splitPane", dir: "row" });
    const splitId = (selected(s1).root as SplitNode).id;
    const hi = reducer(s1, { type: "setRatio", splitId, ratio: 0.99 });
    expect((selected(hi).root as SplitNode).ratio).toBe(0.88);
    const lo = reducer(s1, { type: "setRatio", splitId, ratio: 0.01 });
    expect((selected(lo).root as SplitNode).ratio).toBe(0.12);
  });
});

describe("focus", () => {
  test("focusPane ignores an unknown pane id", () => {
    const s0 = initialState(FOLDER);
    const s = reducer(s0, { type: "focusPane", paneId: "ghost" });
    expect(selected(s).focusedPaneId).toBe(selected(s0).focusedPaneId);
  });
});

describe("workspaces", () => {
  test("addWorkspace appends over its folder and selects it", () => {
    const s = run(addWs(2));
    expect(s.workspaces).toHaveLength(2);
    expect(s.selectedId).toBe(s.workspaces[1].id);
    expect(s.workspaces[1].folder).toBe("/ws/extra-2");
    // The new folder's lists exist, empty, so selectors and counts are total.
    expect(notesOf(s, "/ws/extra-2")).toEqual([]);
    expect(trashOf(s, "/ws/extra-2")).toEqual([]);
  });

  test("addWorkspace can seed its first tab with an existing note", () => {
    // The docs open's move: landing on Getting Started, not an
    // editable-looking scratch tab in a folder that refuses writes.
    const s = run({
      type: "addWorkspace",
      name: "Documentation",
      folder: "/docs",
      note: { path: "/docs/getting-started.md", title: "Getting Started", mtimeMs: 1 },
    });
    const ws = s.workspaces.find((w) => w.folder === "/docs")!;
    expect(ws.root.kind).toBe("leaf");
    if (ws.root.kind !== "leaf") throw new Error("expected leaf");
    expect(ws.root.tabs).toHaveLength(1);
    expect(ws.root.tabs[0].path).toBe("/docs/getting-started.md");
    expect(ws.root.tabs[0].title).toBe("Getting Started");
  });

  test("addWorkspace on a folder that already has a workspace selects it instead", () => {
    // One workspace per folder: attaching an already-attached folder must not
    // grow a twin (two views of one folder would be two lists disagreeing).
    const s1 = run(addWs(2));
    const s2 = reducer(s1, { type: "selectWorkspace", id: s1.workspaces[0].id });
    const s3 = reducer(s2, { type: "addWorkspace", name: "Twin", folder: "/ws/extra-2" });
    expect(s3.workspaces).toHaveLength(2);
    expect(s3.selectedId).toBe(s1.workspaces[1].id);
  });

  test("closeWorkspace removes it, reselects a survivor, and drops its folder's lists", () => {
    const s1 = run(addWs(2));
    const newId = s1.selectedId;
    const s2 = reducer(s1, { type: "closeWorkspace", id: newId });
    expect(s2.workspaces).toHaveLength(1);
    expect(s2.workspaces.some((w) => w.id === newId)).toBe(false);
    expect(s2.selectedId).toBe(s2.workspaces[0].id);
    // The folder's lists went with it (nothing else reads them; the files on
    // disk are untouched — only the view forgets).
    expect(s2.notes["/ws/extra-2"]).toBeUndefined();
    expect(s2.trash["/ws/extra-2"]).toBeUndefined();
  });

  test("closeWorkspace refuses to remove the last workspace", () => {
    const s0 = initialState(FOLDER);
    const s = reducer(s0, { type: "closeWorkspace", id: s0.selectedId });
    expect(s.workspaces).toHaveLength(1);
    expect(s).toBe(s0);
  });

  test("workspaceFolderMoved swaps the folder, keeps identity, and closes every tab", () => {
    const meta: NoteMeta = { path: `${FOLDER}/a.md`, title: "a", mtimeMs: 1 };
    const s1 = run({ type: "openNote", note: meta });
    const before = selected(s1);
    const openDocs = allDocIds(s1);
    expect(openDocs.length).toBeGreaterThan(0);
    const s2 = reducer(s1, { type: "workspaceFolderMoved", id: before.id, folder: "/synced/notes" });
    const after = selected(s2);
    // Same workspace — id, name, icon — over the new folder…
    expect(after.id).toBe(before.id);
    expect(after.name).toBe(before.name);
    expect(after.folder).toBe("/synced/notes");
    // …with a fresh pane tree: the old docIds are gone, which is what App's
    // reconciliation effect turns into editor teardown + closeSession.
    for (const id of openDocs) expect(allDocIds(s2)).not.toContain(id);
    // Old folder's lists dropped, new folder's seeded total.
    expect(s2.notes[FOLDER]).toBeUndefined();
    expect(s2.trash[FOLDER]).toBeUndefined();
    expect(notesOf(s2, "/synced/notes")).toEqual([]);
    expect(trashOf(s2, "/synced/notes")).toEqual([]);
  });

  test("workspaceFolderMoved is a no-op for an unknown id, the same folder, or a taken folder", () => {
    const s0 = run(addWs(2));
    expect(reducer(s0, { type: "workspaceFolderMoved", id: "ws-nope", folder: "/synced/x" })).toBe(s0);
    const id = s0.workspaces[0].id;
    expect(reducer(s0, { type: "workspaceFolderMoved", id, folder: FOLDER })).toBe(s0);
    // One workspace per folder holds against a stale dispatch too.
    expect(reducer(s0, { type: "workspaceFolderMoved", id, folder: "/ws/extra-2" })).toBe(s0);
  });

  test("renameWorkspace trims, and ignores an all-whitespace name", () => {
    const s0 = initialState(FOLDER);
    const id = s0.selectedId;
    expect(selected(reducer(s0, { type: "renameWorkspace", id, name: "  Notes  " })).name).toBe("Notes");
    expect(selected(reducer(s0, { type: "renameWorkspace", id, name: "   " })).name).toBe(selected(s0).name);
  });

  test("renaming a workspace does not touch its folder", () => {
    // Display-only by design: the folder was slugged once at creation, and a
    // rename must not invalidate every path handle under it.
    const s0 = initialState(FOLDER);
    const s = reducer(s0, { type: "renameWorkspace", id: s0.selectedId, name: "Brand New Name" });
    expect(selected(s).folder).toBe(FOLDER);
  });

  test("every workspace starts on the default icon, whatever its position", () => {
    // Icons used to be handed out by index, which made the strip look like the
    // app knew something about a workspace when it only knew its birth order.
    const s = run(addWs(2), addWs(3));
    expect(s.workspaces.map((w) => w.symbol)).toEqual([DEFAULT_ICON, DEFAULT_ICON, DEFAULT_ICON]);
  });

  test("setWorkspaceIcon changes one workspace's icon", () => {
    const s0 = run(addWs(2));
    const s = reducer(s0, { type: "setWorkspaceIcon", id: s0.workspaces[0].id, symbol: "rocket" });
    expect(s.workspaces.map((w) => w.symbol)).toEqual(["rocket", DEFAULT_ICON]);
  });

  test("setWorkspaceIcon ignores a key the catalog doesn't have", () => {
    // iconFor would render the default for it, so storing it would pretend the
    // choice took.
    const s0 = initialState(FOLDER);
    expect(reducer(s0, { type: "setWorkspaceIcon", id: s0.selectedId, symbol: "aardvark" })).toBe(s0);
  });

  test("setWorkspaceIcon ignores an unknown workspace", () => {
    const s0 = initialState(FOLDER);
    expect(selected(reducer(s0, { type: "setWorkspaceIcon", id: "ghost", symbol: "rocket" })).symbol).toBe(
      DEFAULT_ICON,
    );
  });

  test("selectWorkspace ignores an unknown id", () => {
    const s0 = initialState(FOLDER);
    expect(reducer(s0, { type: "selectWorkspace", id: "ghost" })).toBe(s0);
  });
});

describe("moveWorkspace", () => {
  // Build a state with three workspaces; ids [0,1,2].
  function three(): AppState {
    return run(addWs(2), addWs(3));
  }

  test("reorders a workspace to a later slot (index counts the pre-removal list)", () => {
    const s0 = three();
    const ids = s0.workspaces.map((w) => w.id);
    // Drop the first workspace at the end (toIndex 3, past its own slot).
    const s = reducer(s0, { type: "moveWorkspace", id: ids[0], toIndex: 3 });
    expect(s.workspaces.map((w) => w.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(s.selectedId).toBe(s0.selectedId); // selection is unchanged by a move
  });

  test("reorders a workspace to an earlier slot", () => {
    const s0 = three();
    const ids = s0.workspaces.map((w) => w.id);
    const s = reducer(s0, { type: "moveWorkspace", id: ids[2], toIndex: 0 });
    expect(s.workspaces.map((w) => w.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  test("dropping onto its own slot is a no-op", () => {
    const s0 = three();
    const ids = s0.workspaces.map((w) => w.id);
    expect(reducer(s0, { type: "moveWorkspace", id: ids[1], toIndex: 1 })).toBe(s0);
    expect(reducer(s0, { type: "moveWorkspace", id: ids[1], toIndex: 2 })).toBe(s0);
  });

  test("ignores an unknown id", () => {
    const s0 = three();
    expect(reducer(s0, { type: "moveWorkspace", id: "ghost", toIndex: 0 })).toBe(s0);
  });
});

describe("notes", () => {
  const note = (title: string): NoteMeta => ({ path: `${FOLDER}/${title}.md`, title, mtimeMs: 1 });

  // A state seeded from two notes on disk: `a` is the newest, so boot opens it.
  const withNotes = (...actions: Action[]): AppState =>
    actions.reduce(reducer, initialState(FOLDER, [note("a"), note("b")]));

  test("boot opens the most recently modified note", () => {
    const s = initialState(FOLDER, [note("a"), note("b")]);
    expect(focusedTab(selected(s))!.path).toBe(`${FOLDER}/a.md`);
    expect(focusedTab(selected(s))!.title).toBe("a");
  });

  test("boot with no notes on disk opens an unsaved demo note", () => {
    const s = initialState(FOLDER, []);
    expect(focusedTab(selected(s))!.path).toBeNull();
    expect(notesOf(s, FOLDER)).toEqual([]);
  });

  test("openNote on a closed note opens it in the focused pane", () => {
    const s = withNotes({ type: "openNote", note: note("b") });
    expect(countTabs(selected(s).root)).toBe(2);
    expect(focusedTab(selected(s))!.path).toBe(`${FOLDER}/b.md`);
  });

  test("openNote on an already-open note focuses that tab, never opening it twice", () => {
    // Two tabs on one path would mean two docIds and two autosaves racing to
    // write the same file, so this is the rule the whole browser rests on.
    let s = withNotes({ type: "openNote", note: note("b") }); // a and b now open
    const before = countTabs(selected(s).root);
    const bTabId = focusedTab(selected(s))!.id;

    // Switch away to a, then ask for b again.
    const leaf = firstLeaf(selected(s).root);
    s = reducer(s, { type: "selectTab", paneId: leaf.id, tabId: leaf.tabs[0].id });
    expect(focusedTab(selected(s))!.path).toBe(`${FOLDER}/a.md`);

    s = reducer(s, { type: "openNote", note: note("b") });
    expect(countTabs(selected(s).root)).toBe(before); // no new tab
    expect(focusedTab(selected(s))!.id).toBe(bTabId); // the original tab, refocused
  });

  test("openNote finds the note in another workspace and selects it", () => {
    let s = withNotes({ type: "openNote", note: note("b") });
    const home = s.selectedId;
    s = reducer(s, addWs(2));
    expect(s.selectedId).not.toBe(home);

    s = reducer(s, { type: "openNote", note: note("b") });
    expect(s.selectedId).toBe(home); // jumped back to where b lives
    expect(focusedTab(selected(s))!.path).toBe(`${FOLDER}/b.md`);
    // ...and did not open a second copy in the new workspace.
    expect(allDocIds(s).length).toBe(3); // a, b, and the new workspace's seeded tab
  });

  test("noteCreated binds the file to its tab and lists it in its folder", () => {
    const s = withNotes();
    const docId = focusedTab(selected(s))!.docId;
    const created = note("fresh");
    const next = reducer(s, { type: "noteCreated", docId, folder: FOLDER, note: created });

    expect(focusedTab(selected(next))!.path).toBe(created.path);
    expect(focusedTab(selected(next))!.title).toBe("fresh");
    expect(notesOf(next, FOLDER)[0]).toEqual(created); // newest first
  });

  test("noteCreated for a note already listed does not duplicate it", () => {
    const s = withNotes();
    const docId = focusedTab(selected(s))!.docId;
    const next = reducer(s, { type: "noteCreated", docId, folder: FOLDER, note: note("a") });
    expect(notesOf(next, FOLDER).filter((n) => n.path === `${FOLDER}/a.md`)).toHaveLength(1);
  });

  test("notesLoaded replaces one folder's list without touching the tabs or other folders", () => {
    const s = reducer(withNotes(), addWs(2));
    const next = reducer(s, { type: "notesLoaded", folder: "/ws/extra-2", notes: [
      { path: "/ws/extra-2/c.md", title: "c", mtimeMs: 1 },
    ] });
    expect(notesOf(next, "/ws/extra-2").map((n) => n.title)).toEqual(["c"]);
    expect(notesOf(next, FOLDER).map((n) => n.title)).toEqual(["a", "b"]); // untouched
    expect(next.workspaces).toBe(s.workspaces);
  });

  test("openNotePaths reports every open note, ignoring unsaved tabs", () => {
    // newTab adds an unsaved (pathless) tab, which must not appear.
    const s = withNotes({ type: "openNote", note: note("b") }, { type: "newTab" });
    expect(openNotePaths(s)).toEqual(new Set([`${FOLDER}/a.md`, `${FOLDER}/b.md`]));
  });
});

describe("allDocIds", () => {
  test("collects every tab's docId across all workspaces", () => {
    const s = run({ type: "newTab" }, addWs(2));
    const ids = allDocIds(s);
    expect(new Set(ids).size).toBe(ids.length); // unique
    // Two tabs in the first workspace + one seeded tab in the new one.
    expect(ids).toHaveLength(3);
  });
});

describe("rename and delete", () => {
  const note = (title: string): NoteMeta => ({ path: `${FOLDER}/${title}.md`, title, mtimeMs: 1 });
  const withNotes = (...actions: Action[]): AppState =>
    actions.reduce(reducer, initialState(FOLDER, [note("a"), note("b")]));
  const renamed: NoteMeta = { path: `${FOLDER}/renamed.md`, title: "renamed", mtimeMs: 2 };

  test("a rename moves the tab's path and title but keeps its session", () => {
    const before = withNotes();
    const docId = focusedTab(selected(before))!.docId;

    const s = reducer(before, { type: "noteRenamed", path: `${FOLDER}/a.md`, note: renamed });
    const tab = focusedTab(selected(s))!;

    expect(tab.path).toBe(`${FOLDER}/renamed.md`);
    expect(tab.title).toBe("renamed");
    // The point of the whole path/docId split: the editor and the note's shells
    // are keyed by docId, so renaming the file must not disturb them.
    expect(tab.docId).toBe(docId);
    expect(allDocIds(s)).toEqual(allDocIds(before));
  });

  test("a rename updates the note in the browser's list, in place", () => {
    const s = withNotes({ type: "noteRenamed", path: `${FOLDER}/a.md`, note: renamed });
    expect(notesOf(s, FOLDER).map((n) => n.title).sort()).toEqual(["b", "renamed"]);
  });

  test("renaming a note that is not open touches only the list", () => {
    const before = withNotes();
    const s = reducer(before, {
      type: "noteRenamed",
      path: `${FOLDER}/b.md`,
      note: { path: `${FOLDER}/c.md`, title: "c", mtimeMs: 2 },
    });
    expect(notesOf(s, FOLDER).map((n) => n.title).sort()).toEqual(["a", "c"]);
    expect(s.workspaces).toEqual(before.workspaces); // no tab was on b
  });

  test("a rename reaches the note wherever its tab was dragged to", () => {
    // The note opens in workspace 1; a second workspace is added and selected, so
    // the tab holding a.md is no longer in the selected workspace.
    const s = withNotes(addWs(2), {
      type: "noteRenamed",
      path: `${FOLDER}/a.md`,
      note: renamed,
    });
    const home = s.workspaces[0];
    expect(focusedTab(home)!.title).toBe("renamed");
  });

  test("deleting a note closes its tab and drops it from the list", () => {
    const before = withNotes();
    const docId = focusedTab(selected(before))!.docId;

    const s = reducer(before, { type: "noteDeleted", path: `${FOLDER}/a.md` });

    expect(notesOf(s, FOLDER).map((n) => n.title)).toEqual(["b"]);
    expect(countTabs(selected(s).root)).toBe(0);
    // The docId leaving the live set is what makes App tear the editor down and
    // close the note's shells; nothing else does it.
    expect(allDocIds(s)).not.toContain(docId);
  });

  test("deleting a note leaves the other tabs in its pane alone", () => {
    const before = withNotes({ type: "openNote", note: note("b") });
    expect(countTabs(selected(before).root)).toBe(2);

    const s = reducer(before, { type: "noteDeleted", path: `${FOLDER}/a.md` });
    const ws = selected(s);
    expect(countTabs(ws.root)).toBe(1);
    expect(focusedTab(ws)!.path).toBe(`${FOLDER}/b.md`);
    expect(openNotePaths(s)).toEqual(new Set([`${FOLDER}/b.md`]));
  });

  test("deleting the active tab falls to a neighbour, as closing it would", () => {
    // b opens second and is active; deleting it should leave a active, not empty.
    const before = withNotes({ type: "openNote", note: note("b") });
    const s = reducer(before, { type: "noteDeleted", path: `${FOLDER}/b.md` });
    expect(focusedTab(selected(s))!.path).toBe(`${FOLDER}/a.md`);
  });

  test("deleting a note that is not open only touches the list", () => {
    const before = withNotes();
    const s = reducer(before, { type: "noteDeleted", path: `${FOLDER}/b.md` });
    expect(notesOf(s, FOLDER).map((n) => n.title)).toEqual(["a"]);
    expect(s.workspaces).toEqual(before.workspaces);
  });

  test("an unsaved tab is untouched by any rename or delete", () => {
    // A new note has no path yet, so no note operation can match it.
    const before = withNotes({ type: "newTab" });
    const s = reducer(
      reducer(before, { type: "noteRenamed", path: `${FOLDER}/a.md`, note: renamed }),
      { type: "noteDeleted", path: `${FOLDER}/renamed.md` },
    );
    const tab = focusedTab(selected(s))!;
    expect(tab.path).toBeNull();
    expect(allDocIds(s)).toContain(tab.docId);
  });
});

describe("labels", () => {
  const note = (title: string): NoteMeta => ({ path: `${FOLDER}/${title}.md`, title, mtimeMs: 1 });
  const withNotes = (...actions: Action[]): AppState =>
    actions.reduce(reducer, initialState(FOLDER, [note("a"), note("b")]));

  test("a heading edit relabels the tab", () => {
    const before = withNotes();
    const docId = focusedTab(selected(before))!.docId;

    const s = reducer(before, { type: "noteTitled", docId, label: "Shipping Notes" });
    expect(focusedTab(selected(s))!.title).toBe("Shipping Notes");
  });

  test("a heading edit relabels the browser row too, not just the tab", () => {
    // Otherwise the list would sit on the stale heading until the next folder
    // refresh (window focus), which is a long time to look wrong.
    const before = withNotes();
    const docId = focusedTab(selected(before))!.docId;

    const s = reducer(before, { type: "noteTitled", docId, label: "Shipping Notes" });
    expect(notesOf(s, FOLDER).find((n) => n.path === `${FOLDER}/a.md`)!.title).toBe("Shipping Notes");
    expect(notesOf(s, FOLDER).find((n) => n.path === `${FOLDER}/b.md`)!.title).toBe("b"); // untouched
  });

  test("relabelling an unsaved note touches no browser row", () => {
    const before = withNotes({ type: "newTab" });
    const docId = focusedTab(selected(before))!.docId;

    const s = reducer(before, { type: "noteTitled", docId, label: "Fresh Thought" });
    expect(focusedTab(selected(s))!.title).toBe("Fresh Thought");
    expect(s.notes).toEqual(before.notes); // it has no path, so no row is its own
  });

  test("relabelling to the same label changes nothing", () => {
    const before = withNotes();
    const docId = focusedTab(selected(before))!.docId;
    const s = reducer(before, { type: "noteTitled", docId, label: "a" });
    expect(s.workspaces).toEqual(before.workspaces);
  });

  test("an unknown docId is ignored", () => {
    const before = withNotes();
    const s = reducer(before, { type: "noteTitled", docId: "nobody", label: "x" });
    expect(s.workspaces).toEqual(before.workspaces);
    expect(s.notes).toEqual(before.notes);
  });

  test("a relabel reaches a tab in another workspace", () => {
    const before = withNotes();
    const docId = focusedTab(selected(before))!.docId;
    const s = reducer(
      reducer(before, addWs(2)),
      { type: "noteTitled", docId, label: "Shipping Notes" },
    );
    expect(focusedTab(s.workspaces[0])!.title).toBe("Shipping Notes");
  });
});

describe("trash", () => {
  const note = (title: string, mtimeMs = 1): NoteMeta => ({ path: `${FOLDER}/${title}.md`, title, mtimeMs });
  const trashed = (title: string, deletedAt: number): TrashMeta => ({
    path: `${FOLDER}/.ledge-trash/${title}.md`,
    title,
    deletedAt,
  });

  test("initialState carries an empty trash for its folder", () => {
    expect(trashOf(initialState(FOLDER), FOLDER)).toEqual([]);
    expect(trashOf(initialState(FOLDER, [note("a")], [trashed("b", 5)]), FOLDER)).toHaveLength(1);
  });

  test("trashLoaded replaces one folder's list and no other's", () => {
    const s0 = reducer(initialState(FOLDER, [], [trashed("old", 1)]), addWs(2));
    const s = reducer(s0, {
      type: "trashLoaded",
      folder: "/ws/extra-2",
      items: [{ path: "/ws/extra-2/.ledge-trash/new.md", title: "new", deletedAt: 2 }],
    });
    expect(trashOf(s, "/ws/extra-2").map((t) => t.title)).toEqual(["new"]);
    expect(trashOf(s, FOLDER).map((t) => t.title)).toEqual(["old"]); // untouched
  });

  test("noteRestored puts the note back in its folder's browser", () => {
    const s = reducer(initialState(FOLDER, [note("a")]), { type: "noteRestored", folder: FOLDER, note: note("b") });
    expect(notesOf(s, FOLDER).map((n) => n.title).sort()).toEqual(["a", "b"]);
  });

  test("a restored note lands in mtime order, not at the front", () => {
    // It keeps its real last-edited time (the trash records the deletion in
    // ctime and leaves mtime alone), so an old note restored today is still old.
    const s = reducer(initialState(FOLDER, [note("recent", 100), note("older", 10)]), {
      type: "noteRestored",
      folder: FOLDER,
      note: note("ancient", 1),
    });
    expect(notesOf(s, FOLDER).map((n) => n.title)).toEqual(["recent", "older", "ancient"]);
  });

  test("restoring a note that is somehow already listed changes nothing", () => {
    const before = initialState(FOLDER, [note("a")]);
    expect(reducer(before, { type: "noteRestored", folder: FOLDER, note: note("a") })).toBe(before);
  });

  test("noteRestored does not reopen the note's tab", () => {
    // Restore puts a file back; it does not decide you want to look at it.
    const before = initialState(FOLDER);
    const s = reducer(before, { type: "noteRestored", folder: FOLDER, note: note("a") });
    expect(countTabs(selected(s).root)).toBe(countTabs(selected(before).root));
    expect(openNotePaths(s).has(`${FOLDER}/a.md`)).toBe(false);
  });
});
