// Session persistence: the workspace/pane/tab arrangement, serialized to the
// dotted .layout.json Bun keeps in the notes root and rebuilt at boot. The
// file is machine-written state (architecture.md §6), so this module is where
// its one hard requirement lives: a corrupt or stale file must self-heal —
// anything that does not parse or no longer exists costs exactly itself, and
// total failure falls back to a fresh initialState. Never an error dialog over
// a file no human edits.
//
// What is deliberately NOT persisted:
// - ids (workspace/pane/tab/doc). uid() is a per-process counter; docIds name
//   live sessions (editors, shells) that die with the process, so a restored
//   tab gets fresh ids and its editor/shells respawn lazily like any open.
// - unsaved tabs. A tab never typed in has no file (noteCreate fires on first
//   edit) and its text lives nowhere but the editor; persisting its existence
//   without its content would restore a lie. Its pane survives as arrangement
//   and comes back reseeded with a fresh scratch tab.
// - tab titles. The boot noteList is authoritative (a note can be retitled
//   from a shell while Ledge is closed); a persisted title could only be stale.
import {
  firstLeaf,
  makeNoteTab,
  makeTab,
  uid,
  type LeafNode,
  type PaneNode,
  type SplitDir,
  type TabState,
  type Workspace,
} from "./tree";
import { DEFAULT_ICON, isIconKey } from "./icons";
import type { AppState } from "./store";
import { initialState } from "./store";
import type { NoteMeta, TrashMeta } from "../../shared/rpc-schema";

// The persisted shape, version 1. Tabs are note paths — opaque handles the
// view was handed by Bun (architecture.md §2); restore only ever opens paths
// the boot noteList also returned, so a hand-edited file cannot smuggle one in.
interface PersistedLeaf {
  kind: "leaf";
  tabs: string[];
  activeIndex: number;
  focused?: true;
}
interface PersistedSplit {
  kind: "split";
  dir: SplitDir;
  ratio: number;
  children: [PersistedNode, PersistedNode];
}
type PersistedNode = PersistedLeaf | PersistedSplit;
interface PersistedWorkspace {
  name: string;
  symbol: string;
  root: PersistedNode;
}
interface PersistedLayout {
  version: 1;
  selectedIndex: number;
  workspaces: PersistedWorkspace[];
}

// Same bounds the reducer clamps live drags to (store.tsx clampRatio).
function clampRatio(r: number): number {
  return Math.max(0.12, Math.min(0.88, r));
}

// --- serialize --------------------------------------------------------------

function persistNode(node: PaneNode, focusedPaneId: string): PersistedNode {
  if (node.kind === "split") {
    return {
      kind: "split",
      dir: node.dir,
      ratio: node.ratio,
      children: [
        persistNode(node.children[0], focusedPaneId),
        persistNode(node.children[1], focusedPaneId),
      ],
    };
  }
  const kept = node.tabs.filter((t) => t.path !== null);
  // The active tab's slot among the kept tabs. If the active tab itself is
  // unsaved (not persisted), fall to the neighbour that slides into its slot —
  // the same rule closeTab applies, because dropping it at serialize time IS a
  // deferred close.
  let activeIndex = kept.findIndex((t) => t.id === node.activeTabId);
  if (activeIndex < 0) {
    const origIndex = node.tabs.findIndex((t) => t.id === node.activeTabId);
    const before = node.tabs.slice(0, Math.max(origIndex, 0)).filter((t) => t.path !== null).length;
    activeIndex = Math.min(before, Math.max(kept.length - 1, 0));
  }
  return {
    kind: "leaf",
    tabs: kept.map((t) => t.path as string),
    activeIndex,
    ...(node.id === focusedPaneId ? { focused: true as const } : {}),
  };
}

// Exported for unit tests; the app reaches it through scheduleLayoutSave.
export function serializeLayout(state: AppState): string {
  const layout: PersistedLayout = {
    version: 1,
    selectedIndex: Math.max(
      0,
      state.workspaces.findIndex((w) => w.id === state.selectedId),
    ),
    workspaces: state.workspaces.map((ws) => ({
      name: ws.name,
      symbol: ws.symbol,
      root: persistNode(ws.root, ws.focusedPaneId),
    })),
  };
  return JSON.stringify(layout);
}

// --- restore ----------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Rebuild one node, degrading per branch: a malformed half of a split costs
// that half (the sibling takes its place), a whole malformed subtree costs the
// workspace. `opened` spans every workspace: a note open twice would be two
// docIds racing autosaves over one file — the invariant openNote enforces live,
// enforced here against a file that could have been duplicated by hand.
function restoreNode(
  raw: unknown,
  byPath: Map<string, NoteMeta>,
  opened: Set<string>,
  focus: { paneId: string | null },
): PaneNode | null {
  if (!isRecord(raw)) return null;

  if (raw.kind === "split") {
    const children = Array.isArray(raw.children) ? raw.children : [];
    const a = restoreNode(children[0], byPath, opened, focus);
    const b = restoreNode(children[1], byPath, opened, focus);
    if (!a || !b) return a ?? b;
    return {
      kind: "split",
      id: uid("split"),
      dir: raw.dir === "col" ? "col" : "row",
      ratio: typeof raw.ratio === "number" && Number.isFinite(raw.ratio) ? clampRatio(raw.ratio) : 0.5,
      children: [a, b],
    };
  }

  if (raw.kind !== "leaf" || !Array.isArray(raw.tabs)) return null;

  // Survivors: paths that are strings, still exist on disk (per the boot
  // noteList — the only authority on paths), and are not already open in a
  // pane restored before this one. origIndex keys the active-tab fixup below.
  const survivors: Array<{ meta: NoteMeta; origIndex: number }> = [];
  raw.tabs.forEach((p, origIndex) => {
    if (typeof p !== "string" || opened.has(p)) return;
    const meta = byPath.get(p);
    if (!meta) return;
    opened.add(p);
    survivors.push({ meta, origIndex });
  });

  const rawActive = typeof raw.activeIndex === "number" ? raw.activeIndex : 0;
  let active = survivors.findIndex((s) => s.origIndex === rawActive);
  if (active < 0) {
    // The active tab was pruned: fall to the survivor that slid into its slot
    // (closeTab's rule), else the new last.
    const before = survivors.filter((s) => s.origIndex < rawActive).length;
    active = Math.min(before, Math.max(survivors.length - 1, 0));
  }

  // A pane whose every tab was pruned survives as arrangement, reseeded like
  // any fresh pane: an empty pane is a dead grey rectangle (store.tsx), and a
  // note going missing is not a reason to collapse the user's layout — the
  // same stance removeTabsBy takes on delete.
  const tabs: TabState[] =
    survivors.length > 0 ? survivors.map((s) => makeNoteTab(s.meta.path, s.meta.title)) : [makeTab("scratch")];

  const leaf: LeafNode = { kind: "leaf", id: uid("pane"), tabs, activeTabId: tabs[Math.min(active, tabs.length - 1)].id };
  if (raw.focused === true && focus.paneId === null) focus.paneId = leaf.id;
  return leaf;
}

function restoreWorkspace(
  raw: unknown,
  byPath: Map<string, NoteMeta>,
  opened: Set<string>,
  n: number,
): Workspace | null {
  if (!isRecord(raw)) return null;
  const focus: { paneId: string | null } = { paneId: null };
  const root = restoreNode(raw.root, byPath, opened, focus);
  if (!root) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `Workspace ${n}`;
  const symbol = typeof raw.symbol === "string" && isIconKey(raw.symbol) ? raw.symbol : DEFAULT_ICON;
  return { id: uid("ws"), name, symbol, root, focusedPaneId: focus.paneId ?? firstLeaf(root).id };
}

// Rebuild the boot AppState from the saved layout text, or null when there is
// nothing restorable — no file yet, unparseable JSON, an unknown version, or
// no workspace surviving validation. The caller falls back to initialState;
// this function never throws, because the file it reads is machine-written and
// "refuse to boot" is not an acceptable failure mode for it.
// Exported for unit tests; the app goes through restoredState below.
export function restoreLayout(
  text: string | null,
  notes: NoteMeta[],
  trash: TrashMeta[],
): AppState | null {
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || json.version !== 1 || !Array.isArray(json.workspaces)) return null;

  const byPath = new Map(notes.map((m) => [m.path, m]));
  const opened = new Set<string>();
  const workspaces: Workspace[] = [];
  for (const raw of json.workspaces) {
    const ws = restoreWorkspace(raw, byPath, opened, workspaces.length + 1);
    if (ws) workspaces.push(ws);
  }
  if (workspaces.length === 0) return null;

  const rawSelected = typeof json.selectedIndex === "number" ? json.selectedIndex : 0;
  const selected = workspaces[Math.max(0, Math.min(Math.floor(rawSelected), workspaces.length - 1))];
  return { workspaces, selectedId: selected.id, notes, trash };
}

// The boot state: the saved session if it restores, else a fresh start. This
// is main.tsx's (and the harness's) one entry point, so the fallback rule
// lives here rather than at every boot site.
export function restoredState(text: string | null, notes: NoteMeta[], trash: TrashMeta[]): AppState {
  return restoreLayout(text, notes, trash) ?? initialState(notes, trash);
}

// --- the save side ----------------------------------------------------------

// The layout channel, mirroring notes/channel.ts: main.tsx binds save to the
// layoutSave RPC, the harness to memory. Unconfigured is a silent no-op rather
// than a throw — a missed layout save must never take the app down, and the
// debounce timer below fires with no caller left to catch anything.
interface LayoutHandlers {
  save: (text: string) => void;
}

let handlers: LayoutHandlers | null = null;

export function configureLayout(h: LayoutHandlers): void {
  handlers = h;
}

const SAVE_DELAY_MS = 500; // same debounce as note autosave (notes/store.ts)

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: string | null = null;
let lastSaved: string | null = null;

// Called on every workspace-state change (App's effect); serializes eagerly —
// the trees are small — so identical states (focus bounced and came back, say)
// collapse to no write at all.
export function scheduleLayoutSave(state: AppState): void {
  const text = serializeLayout(state);
  if (text === lastSaved) {
    pending = null;
    return;
  }
  pending = text;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushLayout, SAVE_DELAY_MS);
}

// Write the pending layout through now. Called by the timer, and on
// blur/pagehide alongside the note-autosave flush: quit inside the debounce
// window is the one exposure, and it is the same one notes have.
export function flushLayout(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending === null || pending === lastSaved) return;
  lastSaved = pending;
  pending = null;
  handlers?.save(lastSaved);
}
