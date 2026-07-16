import { test, expect, describe } from "bun:test";
import { reducer, initialState, allDocIds, openNotePaths, type AppState, type Action } from "./store";
import { firstLeaf, leafIds, findLeaf, countTabs, focusedTab, type SplitNode } from "./tree";
import type { NoteMeta, TrashMeta } from "../../shared/rpc-schema";

// Apply a sequence of actions from a fresh state.
function run(...actions: Action[]): AppState {
  return actions.reduce(reducer, initialState());
}

const selected = (s: AppState) => s.workspaces.find((w) => w.id === s.selectedId)!;

describe("initialState", () => {
  test("one workspace, selected, with a single seeded tab", () => {
    const s = initialState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.selectedId).toBe(s.workspaces[0].id);
    const ws = selected(s);
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
    const s0 = initialState();
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

  test("closePane collapses back to the sibling and refocuses", () => {
    const s1 = run({ type: "splitPane", dir: "row" });
    const s2 = reducer(s1, { type: "closePane", paneId: selected(s1).focusedPaneId });
    const ws = selected(s2);
    expect(leafIds(ws.root)).toHaveLength(1);
    expect(ws.focusedPaneId).toBe(firstLeaf(ws.root).id);
  });

  test("closePane is a no-op when only one pane remains", () => {
    const s0 = initialState();
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
    const s0 = initialState();
    const s = reducer(s0, { type: "focusPane", paneId: "ghost" });
    expect(selected(s).focusedPaneId).toBe(selected(s0).focusedPaneId);
  });
});

describe("workspaces", () => {
  test("newWorkspace appends and selects it", () => {
    const s = run({ type: "newWorkspace" });
    expect(s.workspaces).toHaveLength(2);
    expect(s.selectedId).toBe(s.workspaces[1].id);
  });

  test("closeWorkspace removes it and reselects a survivor", () => {
    const s1 = run({ type: "newWorkspace" });
    const newId = s1.selectedId;
    const s2 = reducer(s1, { type: "closeWorkspace", id: newId });
    expect(s2.workspaces).toHaveLength(1);
    expect(s2.workspaces.some((w) => w.id === newId)).toBe(false);
    expect(s2.selectedId).toBe(s2.workspaces[0].id);
  });

  test("closeWorkspace refuses to remove the last workspace", () => {
    const s0 = initialState();
    const s = reducer(s0, { type: "closeWorkspace", id: s0.selectedId });
    expect(s.workspaces).toHaveLength(1);
    expect(s).toBe(s0);
  });

  test("renameWorkspace trims, and ignores an all-whitespace name", () => {
    const s0 = initialState();
    const id = s0.selectedId;
    expect(selected(reducer(s0, { type: "renameWorkspace", id, name: "  Notes  " })).name).toBe("Notes");
    expect(selected(reducer(s0, { type: "renameWorkspace", id, name: "   " })).name).toBe(selected(s0).name);
  });

  test("selectWorkspace ignores an unknown id", () => {
    const s0 = initialState();
    expect(reducer(s0, { type: "selectWorkspace", id: "ghost" })).toBe(s0);
  });
});

describe("moveWorkspace", () => {
  // Build a state with three workspaces; ids [0,1,2].
  function three(): AppState {
    return run({ type: "newWorkspace" }, { type: "newWorkspace" });
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
  const note = (title: string): NoteMeta => ({ path: `/notes/${title}.md`, title, mtimeMs: 1 });

  // A state seeded from two notes on disk: `a` is the newest, so boot opens it.
  const withNotes = (...actions: Action[]): AppState =>
    actions.reduce(reducer, initialState([note("a"), note("b")]));

  test("boot opens the most recently modified note", () => {
    const s = initialState([note("a"), note("b")]);
    expect(focusedTab(selected(s))!.path).toBe("/notes/a.md");
    expect(focusedTab(selected(s))!.title).toBe("a");
  });

  test("boot with no notes on disk opens an unsaved demo note", () => {
    const s = initialState([]);
    expect(focusedTab(selected(s))!.path).toBeNull();
    expect(s.notes).toEqual([]);
  });

  test("openNote on a closed note opens it in the focused pane", () => {
    const s = withNotes({ type: "openNote", note: note("b") });
    expect(countTabs(selected(s).root)).toBe(2);
    expect(focusedTab(selected(s))!.path).toBe("/notes/b.md");
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
    expect(focusedTab(selected(s))!.path).toBe("/notes/a.md");

    s = reducer(s, { type: "openNote", note: note("b") });
    expect(countTabs(selected(s).root)).toBe(before); // no new tab
    expect(focusedTab(selected(s))!.id).toBe(bTabId); // the original tab, refocused
  });

  test("openNote finds the note in another workspace and selects it", () => {
    let s = withNotes({ type: "openNote", note: note("b") });
    const home = s.selectedId;
    s = reducer(s, { type: "newWorkspace" });
    expect(s.selectedId).not.toBe(home);

    s = reducer(s, { type: "openNote", note: note("b") });
    expect(s.selectedId).toBe(home); // jumped back to where b lives
    expect(focusedTab(selected(s))!.path).toBe("/notes/b.md");
    // ...and did not open a second copy in the new workspace.
    expect(allDocIds(s).length).toBe(3); // a, b, and the new workspace's seeded tab
  });

  test("noteCreated binds the file to its tab and lists it", () => {
    const s = withNotes();
    const docId = focusedTab(selected(s))!.docId;
    const created = note("fresh");
    const next = reducer(s, { type: "noteCreated", docId, note: created });

    expect(focusedTab(selected(next))!.path).toBe(created.path);
    expect(focusedTab(selected(next))!.title).toBe("fresh");
    expect(next.notes[0]).toEqual(created); // newest first
  });

  test("noteCreated for a note already listed does not duplicate it", () => {
    const s = withNotes();
    const docId = focusedTab(selected(s))!.docId;
    const next = reducer(s, { type: "noteCreated", docId, note: note("a") });
    expect(next.notes.filter((n) => n.path === "/notes/a.md")).toHaveLength(1);
  });

  test("notesLoaded replaces the list without touching the tabs", () => {
    const s = withNotes();
    const next = reducer(s, { type: "notesLoaded", notes: [note("c")] });
    expect(next.notes.map((n) => n.title)).toEqual(["c"]);
    expect(next.workspaces).toBe(s.workspaces);
  });

  test("openNotePaths reports every open note, ignoring unsaved tabs", () => {
    // newTab adds an unsaved (pathless) tab, which must not appear.
    const s = withNotes({ type: "openNote", note: note("b") }, { type: "newTab" });
    expect(openNotePaths(s)).toEqual(new Set(["/notes/a.md", "/notes/b.md"]));
  });
});

describe("allDocIds", () => {
  test("collects every tab's docId across all workspaces", () => {
    const s = run({ type: "newTab" }, { type: "newWorkspace" });
    const ids = allDocIds(s);
    expect(new Set(ids).size).toBe(ids.length); // unique
    // Two tabs in the first workspace + one seeded tab in the new one.
    expect(ids).toHaveLength(3);
  });
});

describe("rename and delete", () => {
  const note = (title: string): NoteMeta => ({ path: `/notes/${title}.md`, title, mtimeMs: 1 });
  const withNotes = (...actions: Action[]): AppState =>
    actions.reduce(reducer, initialState([note("a"), note("b")]));
  const renamed: NoteMeta = { path: "/notes/renamed.md", title: "renamed", mtimeMs: 2 };

  test("a rename moves the tab's path and title but keeps its session", () => {
    const before = withNotes();
    const docId = focusedTab(selected(before))!.docId;

    const s = reducer(before, { type: "noteRenamed", path: "/notes/a.md", note: renamed });
    const tab = focusedTab(selected(s))!;

    expect(tab.path).toBe("/notes/renamed.md");
    expect(tab.title).toBe("renamed");
    // The point of the whole path/docId split: the editor and the note's shells
    // are keyed by docId, so renaming the file must not disturb them.
    expect(tab.docId).toBe(docId);
    expect(allDocIds(s)).toEqual(allDocIds(before));
  });

  test("a rename updates the note in the browser's list, in place", () => {
    const s = withNotes({ type: "noteRenamed", path: "/notes/a.md", note: renamed });
    expect(s.notes.map((n) => n.title).sort()).toEqual(["b", "renamed"]);
  });

  test("renaming a note that is not open touches only the list", () => {
    const before = withNotes();
    const s = reducer(before, {
      type: "noteRenamed",
      path: "/notes/b.md",
      note: { path: "/notes/c.md", title: "c", mtimeMs: 2 },
    });
    expect(s.notes.map((n) => n.title).sort()).toEqual(["a", "c"]);
    expect(s.workspaces).toEqual(before.workspaces); // no tab was on b
  });

  test("a rename reaches the note wherever its tab was dragged to", () => {
    // The note opens in workspace 1; a second workspace is added and selected, so
    // the tab holding /notes/a.md is no longer in the selected workspace.
    const s = withNotes({ type: "newWorkspace" }, {
      type: "noteRenamed",
      path: "/notes/a.md",
      note: renamed,
    });
    const home = s.workspaces[0];
    expect(focusedTab(home)!.title).toBe("renamed");
  });

  test("deleting a note closes its tab and drops it from the list", () => {
    const before = withNotes();
    const docId = focusedTab(selected(before))!.docId;

    const s = reducer(before, { type: "noteDeleted", path: "/notes/a.md" });

    expect(s.notes.map((n) => n.title)).toEqual(["b"]);
    expect(countTabs(selected(s).root)).toBe(0);
    // The docId leaving the live set is what makes App tear the editor down and
    // close the note's shells; nothing else does it.
    expect(allDocIds(s)).not.toContain(docId);
  });

  test("deleting a note leaves the other tabs in its pane alone", () => {
    const before = withNotes({ type: "openNote", note: note("b") });
    expect(countTabs(selected(before).root)).toBe(2);

    const s = reducer(before, { type: "noteDeleted", path: "/notes/a.md" });
    const ws = selected(s);
    expect(countTabs(ws.root)).toBe(1);
    expect(focusedTab(ws)!.path).toBe("/notes/b.md");
    expect(openNotePaths(s)).toEqual(new Set(["/notes/b.md"]));
  });

  test("deleting the active tab falls to a neighbour, as closing it would", () => {
    // b opens second and is active; deleting it should leave a active, not empty.
    const before = withNotes({ type: "openNote", note: note("b") });
    const s = reducer(before, { type: "noteDeleted", path: "/notes/b.md" });
    expect(focusedTab(selected(s))!.path).toBe("/notes/a.md");
  });

  test("deleting a note that is not open only touches the list", () => {
    const before = withNotes();
    const s = reducer(before, { type: "noteDeleted", path: "/notes/b.md" });
    expect(s.notes.map((n) => n.title)).toEqual(["a"]);
    expect(s.workspaces).toEqual(before.workspaces);
  });

  test("an unsaved tab is untouched by any rename or delete", () => {
    // A new note has no path yet, so no note operation can match it.
    const before = withNotes({ type: "newTab" });
    const s = reducer(
      reducer(before, { type: "noteRenamed", path: "/notes/a.md", note: renamed }),
      { type: "noteDeleted", path: "/notes/renamed.md" },
    );
    const tab = focusedTab(selected(s))!;
    expect(tab.path).toBeNull();
    expect(allDocIds(s)).toContain(tab.docId);
  });
});

describe("labels", () => {
  const note = (title: string): NoteMeta => ({ path: `/notes/${title}.md`, title, mtimeMs: 1 });
  const withNotes = (...actions: Action[]): AppState =>
    actions.reduce(reducer, initialState([note("a"), note("b")]));

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
    expect(s.notes.find((n) => n.path === "/notes/a.md")!.title).toBe("Shipping Notes");
    expect(s.notes.find((n) => n.path === "/notes/b.md")!.title).toBe("b"); // untouched
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
      reducer(before, { type: "newWorkspace" }),
      { type: "noteTitled", docId, label: "Shipping Notes" },
    );
    expect(focusedTab(s.workspaces[0])!.title).toBe("Shipping Notes");
  });
});

describe("trash", () => {
  const note = (title: string, mtimeMs = 1): NoteMeta => ({ path: `/notes/${title}.md`, title, mtimeMs });
  const trashed = (title: string, deletedAt: number): TrashMeta => ({
    path: `/notes/.trash/${title}.md`,
    title,
    deletedAt,
  });

  test("initialState carries an empty trash", () => {
    expect(initialState().trash).toEqual([]);
    expect(initialState([note("a")], [trashed("b", 5)]).trash).toHaveLength(1);
  });

  test("trashLoaded replaces the list", () => {
    const s = reducer(initialState([], [trashed("old", 1)]), {
      type: "trashLoaded",
      items: [trashed("new", 2)],
    });
    expect(s.trash.map((t) => t.title)).toEqual(["new"]);
  });

  test("noteRestored puts the note back in the browser", () => {
    const s = reducer(initialState([note("a")]), { type: "noteRestored", note: note("b") });
    expect(s.notes.map((n) => n.title).sort()).toEqual(["a", "b"]);
  });

  test("a restored note lands in mtime order, not at the front", () => {
    // It keeps its real last-edited time (the trash records the deletion in
    // ctime and leaves mtime alone), so an old note restored today is still old.
    const s = reducer(initialState([note("recent", 100), note("older", 10)]), {
      type: "noteRestored",
      note: note("ancient", 1),
    });
    expect(s.notes.map((n) => n.title)).toEqual(["recent", "older", "ancient"]);
  });

  test("restoring a note that is somehow already listed changes nothing", () => {
    const before = initialState([note("a")]);
    expect(reducer(before, { type: "noteRestored", note: note("a") })).toBe(before);
  });

  test("noteRestored does not reopen the note's tab", () => {
    // Restore puts a file back; it does not decide you want to look at it.
    const before = initialState();
    const s = reducer(before, { type: "noteRestored", note: note("a") });
    expect(countTabs(selected(s).root)).toBe(countTabs(selected(before).root));
    expect(openNotePaths(s).has("/notes/a.md")).toBe(false);
  });
});
