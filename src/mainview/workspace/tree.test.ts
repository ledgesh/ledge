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
  type LeafNode,
  type SplitNode,
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
