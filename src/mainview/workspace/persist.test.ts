// Session persistence: the serialize/restore round trip and, mostly, the
// self-healing — .layout.json is machine-written state (architecture.md §6),
// so every malformed or stale piece must cost exactly itself and total
// failure must fall back to a fresh start, never a throw.
import { describe, expect, test } from "bun:test";
import type { NoteMeta } from "../../shared/rpc-schema";
import { initialState, reducer, type AppState } from "./store";
import { findLeaf, firstLeaf, tabPaths, type LeafNode, type SplitNode } from "./tree";
import { restoreLayout, restoredState, serializeLayout } from "./persist";
import { DEFAULT_ICON } from "./icons";

function note(path: string, title: string, mtimeMs = 1): NoteMeta {
  return { path, title, mtimeMs };
}

const NOTES = [
  note("/r/alpha.md", "Alpha", 3),
  note("/r/beta.md", "Beta", 2),
  note("/r/gamma.md", "Gamma", 1),
];

// A state exercising everything the layout records: two workspaces, a split,
// tab order, active tabs, focus, selection. Built through the reducer, per
// testing.md §4 — hand-assembled AppState literals rot as the shape grows.
function richState(): AppState {
  let s = initialState(NOTES);
  s = reducer(s, { type: "renameWorkspace", id: s.workspaces[0].id, name: "Writing" });
  s = reducer(s, { type: "setWorkspaceIcon", id: s.workspaces[0].id, symbol: "terminal" });
  s = reducer(s, { type: "openNote", note: NOTES[1] });
  s = reducer(s, { type: "splitPane", dir: "row" });
  s = reducer(s, { type: "openNote", note: NOTES[2] });
  s = reducer(s, { type: "newWorkspace" });
  return s;
}

describe("round trip", () => {
  test("workspaces, splits, tabs, active tab, focus, and selection survive", () => {
    const before = richState();
    const after = restoreLayout(serializeLayout(before), NOTES, []);
    expect(after).not.toBeNull();

    expect(after!.workspaces.length).toBe(2);
    const [w1, w2] = after!.workspaces;
    expect(w1.name).toBe("Writing");
    expect(w1.symbol).toBe("terminal");
    expect(w2.name).toBe("Workspace 2");

    // The split came back with its shape: alpha+beta on the left, gamma right.
    expect(w1.root.kind).toBe("split");
    const root = w1.root as SplitNode;
    expect(root.dir).toBe("row");
    const left = root.children[0] as LeafNode;
    const right = root.children[1] as LeafNode;
    expect(left.tabs.map((t) => t.path)).toEqual(["/r/alpha.md", "/r/beta.md"]);
    expect(left.activeTabId).toBe(left.tabs[1].id); // beta was the active tab
    expect(right.tabs.map((t) => t.path)).toEqual(["/r/gamma.md"]);

    // The new (right) pane held focus when the state was saved.
    expect(w1.focusedPaneId).toBe(right.id);

    // The second workspace was selected at save time.
    expect(after!.selectedId).toBe(w2.id);
  });

  test("restored ids are fresh: docIds name live sessions, which died with the process", () => {
    const before = richState();
    const after = restoreLayout(serializeLayout(before), NOTES, [])!;
    const beforeDocs = before.workspaces.flatMap((w) => firstLeaf(w.root).tabs.map((t) => t.docId));
    const afterDocs = after.workspaces.flatMap((w) => firstLeaf(w.root).tabs.map((t) => t.docId));
    for (const d of afterDocs) expect(beforeDocs).not.toContain(d);
  });

  test("tab titles come from the boot noteList, not the file: a persisted title can only be stale", () => {
    const s = initialState([note("/r/alpha.md", "Old Title")]);
    const text = serializeLayout(s);
    const after = restoreLayout(text, [note("/r/alpha.md", "Renamed In A Shell")], [])!;
    expect(firstLeaf(after.workspaces[0].root).tabs[0].title).toBe("Renamed In A Shell");
  });
});

describe("pruning", () => {
  test("a persisted note that no longer exists is dropped, and the neighbour inherits its active slot", () => {
    let s = initialState(NOTES); // opens alpha
    s = reducer(s, { type: "openNote", note: NOTES[1] });
    s = reducer(s, { type: "openNote", note: NOTES[2] });
    s = reducer(s, { type: "selectTab", paneId: s.workspaces[0].focusedPaneId, tabId: firstLeaf(s.workspaces[0].root).tabs[1].id });
    // beta (the active tab) was deleted while the app was closed.
    const survivors = [NOTES[0], NOTES[2]];
    const after = restoreLayout(serializeLayout(s), survivors, [])!;
    const leaf = firstLeaf(after.workspaces[0].root);
    expect(leaf.tabs.map((t) => t.path)).toEqual(["/r/alpha.md", "/r/gamma.md"]);
    // closeTab's rule: gamma slid into beta's slot and takes its active status.
    expect(leaf.activeTabId).toBe(leaf.tabs[1].id);
  });

  test("unsaved tabs are not persisted: their text lives only in the editor", () => {
    let s = initialState(NOTES);
    s = reducer(s, { type: "newTab" }); // a scratch tab, never typed in
    const after = restoreLayout(serializeLayout(s), NOTES, [])!;
    const leaf = firstLeaf(after.workspaces[0].root);
    expect(leaf.tabs.map((t) => t.path)).toEqual(["/r/alpha.md"]);
    // The unsaved tab was active; its saved neighbour inherits.
    expect(leaf.activeTabId).toBe(leaf.tabs[0].id);
  });

  test("a pane whose every tab was pruned survives as arrangement, reseeded with a scratch tab", () => {
    let s = initialState(NOTES);
    s = reducer(s, { type: "splitPane", dir: "col" }); // new pane holds only a scratch tab
    const after = restoreLayout(serializeLayout(s), NOTES, [])!;
    expect(after.workspaces[0].root.kind).toBe("split");
    const seeded = (after.workspaces[0].root as SplitNode).children[1] as LeafNode;
    expect(seeded.tabs.length).toBe(1);
    expect(seeded.tabs[0].path).toBeNull();
  });

  test("a note duplicated across the file opens once: two tabs on one path would race autosaves", () => {
    const text = JSON.stringify({
      version: 1,
      selectedIndex: 0,
      workspaces: [
        { name: "A", symbol: DEFAULT_ICON, root: { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 0 } },
        { name: "B", symbol: DEFAULT_ICON, root: { kind: "leaf", tabs: ["/r/alpha.md", "/r/beta.md"], activeIndex: 0 } },
      ],
    });
    const after = restoreLayout(text, NOTES, [])!;
    const all = after.workspaces.flatMap((w) => tabPaths(w.root));
    expect(all.filter((p) => p === "/r/alpha.md").length).toBe(1);
    // The duplicate was dropped from B, whose remaining tab carries on.
    expect(tabPaths(after.workspaces[1].root)).toEqual(["/r/beta.md"]);
  });
});

describe("self-healing", () => {
  test("no saved layout, unparseable JSON, a non-object, and an unknown version each fall back to a fresh start", () => {
    for (const text of [null, "{not json", '"a string"', JSON.stringify({ version: 2, workspaces: [] })]) {
      expect(restoreLayout(text, NOTES, [])).toBeNull();
      // ...and restoredState turns that into initialState's single-note boot.
      const s = restoredState(text, NOTES, []);
      expect(s.workspaces.length).toBe(1);
      expect(firstLeaf(s.workspaces[0].root).tabs[0].path).toBe("/r/alpha.md");
    }
  });

  test("a malformed workspace costs itself, not the file", () => {
    const text = JSON.stringify({
      version: 1,
      selectedIndex: 0,
      workspaces: [
        { name: "Good", symbol: DEFAULT_ICON, root: { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 0 } },
        { name: "Bad", symbol: DEFAULT_ICON, root: { kind: "what" } },
      ],
    });
    const after = restoreLayout(text, NOTES, [])!;
    expect(after.workspaces.length).toBe(1);
    expect(after.workspaces[0].name).toBe("Good");
  });

  test("a malformed half of a split costs that half: the sibling takes its place", () => {
    const text = JSON.stringify({
      version: 1,
      selectedIndex: 0,
      workspaces: [
        {
          name: "A",
          symbol: DEFAULT_ICON,
          root: {
            kind: "split",
            dir: "row",
            ratio: 0.5,
            children: [42, { kind: "leaf", tabs: ["/r/beta.md"], activeIndex: 0 }],
          },
        },
      ],
    });
    const after = restoreLayout(text, NOTES, [])!;
    const root = after.workspaces[0].root;
    expect(root.kind).toBe("leaf");
    expect((root as LeafNode).tabs[0].path).toBe("/r/beta.md");
  });

  test("every workspace failing means no restore at all", () => {
    const text = JSON.stringify({ version: 1, selectedIndex: 0, workspaces: [{ root: null }, "junk"] });
    expect(restoreLayout(text, NOTES, [])).toBeNull();
  });

  test("bad fields degrade alone: ratio clamps, dir defaults, name and symbol fall back, selection clamps", () => {
    const text = JSON.stringify({
      version: 1,
      selectedIndex: 99,
      workspaces: [
        {
          name: "   ",
          symbol: "not-an-icon",
          root: {
            kind: "split",
            dir: "diagonal",
            ratio: 7,
            children: [
              { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 99 },
              { kind: "leaf", tabs: ["/r/beta.md"], activeIndex: 0 },
            ],
          },
        },
      ],
    });
    const after = restoreLayout(text, NOTES, [])!;
    const ws = after.workspaces[0];
    expect(ws.name).toBe("Workspace 1");
    expect(ws.symbol).toBe(DEFAULT_ICON);
    const root = ws.root as SplitNode;
    expect(root.dir).toBe("row");
    expect(root.ratio).toBe(0.88); // same clamp the reducer applies to drags
    const left = root.children[0] as LeafNode;
    expect(left.activeTabId).toBe(left.tabs[0].id); // out-of-range active clamps
    expect(after.selectedId).toBe(ws.id); // out-of-range selection clamps
  });

  test("a path that is not a string is dropped, not opened: paths are opaque handles from the noteList", () => {
    const text = JSON.stringify({
      version: 1,
      selectedIndex: 0,
      workspaces: [
        {
          name: "A",
          symbol: DEFAULT_ICON,
          root: { kind: "leaf", tabs: [42, { evil: true }, "/r/alpha.md", "/r/not-listed.md"], activeIndex: 0 },
        },
      ],
    });
    const after = restoreLayout(text, NOTES, [])!;
    expect(tabPaths(after.workspaces[0].root)).toEqual(["/r/alpha.md"]);
  });

  test("focus falls back to the first pane when no leaf carries the flag", () => {
    const text = JSON.stringify({
      version: 1,
      selectedIndex: 0,
      workspaces: [
        { name: "A", symbol: DEFAULT_ICON, root: { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 0 } },
      ],
    });
    const after = restoreLayout(text, NOTES, [])!;
    const ws = after.workspaces[0];
    expect(findLeaf(ws.root, ws.focusedPaneId)).not.toBeNull();
  });
});
