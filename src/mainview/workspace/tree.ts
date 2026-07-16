// The pane-tree model for the cmux-style layout, ported from the Swift build's
// Bonsplit tree. A workspace owns a binary tree of panes: `split` nodes divide
// space between two children along an axis, `leaf` nodes are the actual panes
// that carry a horizontal tab bar. Every operation here is pure and returns a
// fresh tree, so the reducer in store.tsx can treat state as immutable.

export type SplitDir = "row" | "col"; // row: children sit left|right; col: top|bottom

// One tab in a pane. `docId` is the stable key into the editor pool
// (editorPool.ts): it outlives tab moves and re-parenting, which is what keeps a
// CodeMirror instance (and its undo/scroll/inline output) alive across switches.
export interface TabState {
  id: string;
  title: string;
  docId: string;
  seed: "demo" | "scratch";
}

export interface LeafNode {
  kind: "leaf";
  id: string; // pane id
  tabs: TabState[];
  activeTabId: string; // "" when the pane is empty
}

export interface SplitNode {
  kind: "split";
  id: string;
  dir: SplitDir;
  children: [PaneNode, PaneNode];
  ratio: number; // fraction of space given to the first child, 0..1
}

export type PaneNode = LeafNode | SplitNode;

export interface Workspace {
  id: string;
  name: string;
  symbol: string; // lucide icon key (see Sidebar.tsx)
  root: PaneNode;
  focusedPaneId: string;
}

// --- ids -------------------------------------------------------------------

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- tab / leaf factories --------------------------------------------------

export function makeTab(seed: "demo" | "scratch", title = "Untitled"): TabState {
  return { id: uid("tab"), title, docId: uid("doc"), seed };
}

export function makeLeaf(tab: TabState): LeafNode {
  return { kind: "leaf", id: uid("pane"), tabs: [tab], activeTabId: tab.id };
}

// --- queries ---------------------------------------------------------------

export function firstLeaf(node: PaneNode): LeafNode {
  return node.kind === "leaf" ? node : firstLeaf(node.children[0]);
}

export function leafIds(node: PaneNode): string[] {
  if (node.kind === "leaf") return [node.id];
  return [...leafIds(node.children[0]), ...leafIds(node.children[1])];
}

export function findLeaf(node: PaneNode, paneId: string): LeafNode | null {
  if (node.kind === "leaf") return node.id === paneId ? node : null;
  return findLeaf(node.children[0], paneId) ?? findLeaf(node.children[1], paneId);
}

export function tabDocIds(node: PaneNode): string[] {
  if (node.kind === "leaf") return node.tabs.map((t) => t.docId);
  return [...tabDocIds(node.children[0]), ...tabDocIds(node.children[1])];
}

export function countTabs(node: PaneNode): number {
  if (node.kind === "leaf") return node.tabs.length;
  return countTabs(node.children[0]) + countTabs(node.children[1]);
}

// --- transforms (all return a new tree) ------------------------------------

// Replace the leaf `paneId` with `fn(leaf)`, rebuilding only the spine to it.
export function updateLeaf(node: PaneNode, paneId: string, fn: (leaf: LeafNode) => LeafNode): PaneNode {
  if (node.kind === "leaf") return node.id === paneId ? fn(node) : node;
  const a = updateLeaf(node.children[0], paneId, fn);
  const b = updateLeaf(node.children[1], paneId, fn);
  if (a === node.children[0] && b === node.children[1]) return node;
  return { ...node, children: [a, b] };
}

// Split the leaf `paneId` into a new split node holding [existing, newLeaf].
export function splitLeaf(node: PaneNode, paneId: string, dir: SplitDir, newLeaf: LeafNode): PaneNode {
  if (node.kind === "leaf") {
    if (node.id !== paneId) return node;
    return { kind: "split", id: uid("split"), dir, children: [node, newLeaf], ratio: 0.5 };
  }
  const a = splitLeaf(node.children[0], paneId, dir, newLeaf);
  const b = splitLeaf(node.children[1], paneId, dir, newLeaf);
  if (a === node.children[0] && b === node.children[1]) return node;
  return { ...node, children: [a, b] };
}

// Remove the leaf `paneId`, collapsing its parent split into the sibling. Returns
// the same tree if the pane is the whole tree (the last pane cannot be closed).
export function removeLeaf(node: PaneNode, paneId: string): PaneNode {
  if (node.kind === "leaf") return node; // top-level leaf: nothing to collapse into
  const [a, b] = node.children;
  if (a.kind === "leaf" && a.id === paneId) return b;
  if (b.kind === "leaf" && b.id === paneId) return a;
  const na = removeLeaf(a, paneId);
  const nb = removeLeaf(b, paneId);
  if (na === a && nb === b) return node;
  return { ...node, children: [na, nb] };
}

export function setRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio };
  const a = setRatio(node.children[0], splitId, ratio);
  const b = setRatio(node.children[1], splitId, ratio);
  if (a === node.children[0] && b === node.children[1]) return node;
  return { ...node, children: [a, b] };
}

function clampIndex(i: number, len: number): number {
  return Math.max(0, Math.min(i, len));
}

// Move `tabId` out of `fromPaneId` and drop it into `toPaneId` at `toIndex`.
// Within one pane this is a reorder; across panes it detaches from the source and
// inserts into the destination. The docId travels with the tab, so the pooled
// editor (undo/scroll/inline output) survives the move untouched.
//
// `toIndex` counts the destination pane's tabs *as displayed at drop time*: when
// reordering within a pane that array still contains the dragged tab, so an index
// past the tab's own slot is shifted down by one after removal. The moved tab
// becomes active in the destination; if it was the active tab in a *different*
// source pane, that pane falls to the neighbour that slid into its slot (the same
// rule closeTab uses), or empties if it was the last tab.
export function moveTab(
  root: PaneNode,
  fromPaneId: string,
  tabId: string,
  toPaneId: string,
  toIndex: number,
): PaneNode {
  const from = findLeaf(root, fromPaneId);
  const moving = from?.tabs.find((t) => t.id === tabId);
  if (!from || !moving) return root;

  if (fromPaneId === toPaneId) {
    const oldIndex = from.tabs.findIndex((t) => t.id === tabId);
    const without = from.tabs.filter((t) => t.id !== tabId);
    const idx = clampIndex(toIndex > oldIndex ? toIndex - 1 : toIndex, without.length);
    if (idx === oldIndex) return root; // dropped back onto its own slot
    const tabs = [...without.slice(0, idx), moving, ...without.slice(idx)];
    return updateLeaf(root, fromPaneId, (leaf) => ({ ...leaf, tabs, activeTabId: tabId }));
  }

  const detached = updateLeaf(root, fromPaneId, (leaf) => {
    const idx = leaf.tabs.findIndex((t) => t.id === tabId);
    const tabs = leaf.tabs.filter((t) => t.id !== tabId);
    let activeTabId = leaf.activeTabId;
    if (activeTabId === tabId) {
      const next = tabs[idx] ?? tabs[idx - 1];
      activeTabId = next ? next.id : "";
    }
    return { ...leaf, tabs, activeTabId };
  });
  return updateLeaf(detached, toPaneId, (leaf) => {
    const idx = clampIndex(toIndex, leaf.tabs.length);
    const tabs = [...leaf.tabs.slice(0, idx), moving, ...leaf.tabs.slice(idx)];
    return { ...leaf, tabs, activeTabId: tabId };
  });
}
