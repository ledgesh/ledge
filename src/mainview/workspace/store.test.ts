import { test, expect, describe } from "bun:test";
import { reducer, initialState, allDocIds, type AppState, type Action } from "./store";
import { firstLeaf, leafIds, findLeaf, countTabs, type SplitNode } from "./tree";

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

describe("allDocIds", () => {
  test("collects every tab's docId across all workspaces", () => {
    const s = run({ type: "newTab" }, { type: "newWorkspace" });
    const ids = allDocIds(s);
    expect(new Set(ids).size).toBe(ids.length); // unique
    // Two tabs in the first workspace + one seeded tab in the new one.
    expect(ids).toHaveLength(3);
  });
});
