import { test, expect, describe } from "bun:test";
import {
  makeTab,
  makeLeaf,
  firstLeaf,
  leafIds,
  findLeaf,
  tabDocIds,
  countTabs,
  updateLeaf,
  splitLeaf,
  removeLeaf,
  setRatio,
  moveTab,
  focusedDocId,
  type LeafNode,
  type SplitNode,
  type Workspace,
} from "./tree";

describe("factories", () => {
  test("makeTab carries seed and mints distinct doc/tab ids", () => {
    const a = makeTab("scratch", "Title");
    const b = makeTab("demo");
    expect(a.seed).toBe("scratch");
    expect(a.title).toBe("Title");
    expect(b.title).toBe("Untitled");
    expect(a.id).not.toBe(b.id);
    expect(a.docId).not.toBe(b.docId);
  });

  test("makeLeaf activates its only tab", () => {
    const tab = makeTab("scratch");
    const leaf = makeLeaf(tab);
    expect(leaf.kind).toBe("leaf");
    expect(leaf.tabs).toEqual([tab]);
    expect(leaf.activeTabId).toBe(tab.id);
  });
});

// A small fixture: split A -> [A, B].
function twoPane() {
  const a = makeLeaf(makeTab("scratch"));
  const b = makeLeaf(makeTab("scratch"));
  const root = splitLeaf(a, a.id, "row", b) as SplitNode;
  return { a, b, root };
}

describe("splitLeaf", () => {
  test("wraps the target leaf in a split with the new leaf, ratio 0.5", () => {
    const { a, b, root } = twoPane();
    expect(root.kind).toBe("split");
    expect(root.dir).toBe("row");
    expect(root.ratio).toBe(0.5);
    expect(root.children).toEqual([a, b]);
  });

  test("leaves the tree untouched (same reference) when the pane id is absent", () => {
    const a = makeLeaf(makeTab("scratch"));
    const out = splitLeaf(a, "missing", "row", makeLeaf(makeTab("scratch")));
    expect(out).toBe(a);
  });
});

describe("queries", () => {
  test("firstLeaf descends to the leftmost leaf", () => {
    const { a, root } = twoPane();
    expect(firstLeaf(root)).toBe(a);
  });

  test("leafIds lists every leaf left to right", () => {
    const { a, b, root } = twoPane();
    expect(leafIds(root)).toEqual([a.id, b.id]);
  });

  test("findLeaf returns the leaf or null", () => {
    const { b, root } = twoPane();
    expect(findLeaf(root, b.id)).toBe(b);
    expect(findLeaf(root, "nope")).toBeNull();
  });

  test("countTabs and tabDocIds sum across the tree", () => {
    const { a, b, root } = twoPane();
    expect(countTabs(root)).toBe(2);
    expect(tabDocIds(root)).toEqual([a.tabs[0].docId, b.tabs[0].docId]);
  });
});

describe("updateLeaf", () => {
  test("rewrites the matching leaf and preserves untouched subtrees by reference", () => {
    const { a, b, root } = twoPane();
    const next = updateLeaf(root, a.id, (leaf) => ({ ...leaf, activeTabId: "changed" })) as SplitNode;
    expect(next).not.toBe(root);
    expect((next.children[0] as LeafNode).activeTabId).toBe("changed");
    expect(next.children[1]).toBe(b); // sibling untouched -> same reference
  });

  test("returns the same tree when no leaf matches", () => {
    const { root } = twoPane();
    expect(updateLeaf(root, "missing", (l) => l)).toBe(root);
  });
});

describe("removeLeaf", () => {
  test("collapses the parent split into the surviving sibling", () => {
    const { a, b, root } = twoPane();
    expect(removeLeaf(root, b.id)).toBe(a);
    expect(removeLeaf(root, a.id)).toBe(b);
  });

  test("a lone top-level leaf cannot be removed (last pane)", () => {
    const a = makeLeaf(makeTab("scratch"));
    expect(removeLeaf(a, a.id)).toBe(a);
  });

  test("collapses correctly inside a nested split", () => {
    // split(A, split(B, C))
    const a = makeLeaf(makeTab("scratch"));
    const b = makeLeaf(makeTab("scratch"));
    const c = makeLeaf(makeTab("scratch"));
    const inner = splitLeaf(b, b.id, "col", c);
    const root = { kind: "split", id: "root", dir: "row", children: [a, inner], ratio: 0.5 } as SplitNode;

    const afterC = removeLeaf(root, c.id) as SplitNode;
    expect(leafIds(afterC)).toEqual([a.id, b.id]); // inner split collapsed to B
    expect(afterC.children[1]).toBe(b);

    const afterB = removeLeaf(root, b.id) as SplitNode;
    expect(leafIds(afterB)).toEqual([a.id, c.id]);
  });
});

describe("setRatio", () => {
  test("updates the matching split and preserves the rest by reference", () => {
    const { b, root } = twoPane();
    const next = setRatio(root, root.id, 0.3) as SplitNode;
    expect(next.ratio).toBe(0.3);
    expect(next.children[1]).toBe(b);
  });

  test("no-op for an unknown split id", () => {
    const { root } = twoPane();
    expect(setRatio(root, "missing", 0.3)).toBe(root);
  });
});

describe("moveTab", () => {
  // A leaf with `n` tabs, the first active. Returns the leaf and its tab ids.
  function leafWith(n: number) {
    let leaf = makeLeaf(makeTab("scratch"));
    for (let i = 1; i < n; i++) leaf = { ...leaf, tabs: [...leaf.tabs, makeTab("scratch")] };
    return { leaf, ids: leaf.tabs.map((t) => t.id) };
  }
  const tabIds = (leaf: LeafNode) => leaf.tabs.map((t) => t.id);

  describe("reorder within one pane", () => {
    test("moving right: drop index counts the tab's own slot, so it lands before the target", () => {
      const { leaf, ids } = leafWith(3); // [0,1,2]
      const out = moveTab(leaf, leaf.id, ids[0], leaf.id, 2) as LeafNode;
      expect(out.tabs.map((t) => t.id)).toEqual([ids[1], ids[0], ids[2]]);
      expect(out.activeTabId).toBe(ids[0]); // moved tab stays active
    });

    test("moving to the far right end", () => {
      const { leaf, ids } = leafWith(3);
      const out = moveTab(leaf, leaf.id, ids[0], leaf.id, 3) as LeafNode;
      expect(out.tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
    });

    test("moving left", () => {
      const { leaf, ids } = leafWith(3);
      const out = moveTab(leaf, leaf.id, ids[2], leaf.id, 0) as LeafNode;
      expect(out.tabs.map((t) => t.id)).toEqual([ids[2], ids[0], ids[1]]);
    });

    test("dropping onto its own slot is a no-op (same tree reference)", () => {
      const { leaf, ids } = leafWith(3);
      expect(moveTab(leaf, leaf.id, ids[1], leaf.id, 1)).toBe(leaf);
      expect(moveTab(leaf, leaf.id, ids[1], leaf.id, 2)).toBe(leaf); // just past itself, adjusted back
    });
  });

  describe("move across panes", () => {
    // split A[0,1] | B[x]
    function twoLeaves() {
      const a = leafWith(2);
      const b = leafWith(1);
      const root = splitLeaf(a.leaf, a.leaf.id, "row", b.leaf) as SplitNode;
      return { a, b, root };
    }

    test("detaches from source and inserts into destination at the given index, active there", () => {
      const { a, b, root } = twoLeaves();
      const out = moveTab(root, a.leaf.id, a.ids[1], b.leaf.id, 0);
      expect(tabIds(findLeaf(out, a.leaf.id)!)).toEqual([a.ids[0]]);
      const dest = findLeaf(out, b.leaf.id)!;
      expect(dest.tabs.map((t) => t.id)).toEqual([a.ids[1], b.ids[0]]);
      expect(dest.activeTabId).toBe(a.ids[1]);
    });

    test("moving the active source tab falls the source to the slid-in neighbour", () => {
      const { a, b, root } = twoLeaves(); // A active tab is ids[0]
      const out = moveTab(root, a.leaf.id, a.ids[0], b.leaf.id, 1);
      const src = findLeaf(out, a.leaf.id)!;
      expect(src.tabs.map((t) => t.id)).toEqual([a.ids[1]]);
      expect(src.activeTabId).toBe(a.ids[1]);
    });

    test("moving the last tab out empties the source pane", () => {
      const { b, root } = twoLeaves();
      const out = moveTab(root, b.leaf.id, b.ids[0], (root.children[0] as LeafNode).id, 0);
      const src = findLeaf(out, b.leaf.id)!;
      expect(src.tabs).toHaveLength(0);
      expect(src.activeTabId).toBe("");
    });
  });

  test("no-op when the tab or source pane is absent", () => {
    const { leaf, ids } = leafWith(2);
    expect(moveTab(leaf, "ghost-pane", ids[0], leaf.id, 0)).toBe(leaf);
    expect(moveTab(leaf, leaf.id, "ghost-tab", leaf.id, 0)).toBe(leaf);
  });
});

describe("focusedDocId", () => {
  const ws = (root: LeafNode | SplitNode, focusedPaneId: string): Workspace => ({
    id: "ws",
    name: "W",
    symbol: "inbox",
    root,
    focusedPaneId,
  });

  test("returns the active tab's docId in the focused pane", () => {
    const a = makeLeaf(makeTab("scratch"));
    const b = makeLeaf(makeTab("scratch"));
    const root = splitLeaf(a, a.id, "row", b) as SplitNode;
    expect(focusedDocId(ws(root, a.id))).toBe(a.tabs[0].docId);
    expect(focusedDocId(ws(root, b.id))).toBe(b.tabs[0].docId);
  });

  test("follows the active tab, not just the first tab, of the focused pane", () => {
    const t0 = makeTab("scratch");
    const t1 = makeTab("scratch");
    const leaf: LeafNode = { kind: "leaf", id: "p", tabs: [t0, t1], activeTabId: t1.id };
    expect(focusedDocId(ws(leaf, "p"))).toBe(t1.docId);
  });

  test("is null when the focused pane is empty or missing", () => {
    const empty: LeafNode = { kind: "leaf", id: "p", tabs: [], activeTabId: "" };
    expect(focusedDocId(ws(empty, "p"))).toBeNull();
    expect(focusedDocId(ws(makeLeaf(makeTab("scratch")), "ghost"))).toBeNull();
  });
});
