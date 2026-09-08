// Session persistence: the workspace, pane and tab arrangement, serialized to
// the dotted .layout.json Bun keeps in the app home and rebuilt at boot. The
// file is machine-written state (architecture.md §6), so this module must
// rebuild around a corrupt or stale one. Anything that does not parse, or that
// no longer exists, is dropped and nothing else with it; a file that fails
// outright falls back to a fresh initialState. No error dialog, since no human
// edits this file.
//
// What is not persisted:
// - ids (workspace, pane, tab, doc). uid() counts per process, and docIds name
//   live sessions (editors, shells) that end with the process. A restored tab
//   gets fresh ids and respawns its editor and shells lazily.
// - unsaved tabs. A tab never typed in has no file, since noteCreate fires on
//   the first edit, and its text lives nowhere but the editor. Saving the tab
//   without its text would restore an empty tab. Its pane comes back holding
//   a fresh scratch tab.
// - tab titles. A note can be retitled from a shell while Ledge is closed, so
//   the boot noteList is authoritative and a saved title could only be stale.
//
// One thing this module saves does not come from AppState: which folders the
// note browser has open. That set lives in notes/expansion.ts, a mirrored
// module rather than reducer state (architecture.md §5). This module reads it
// on the way to the file and seeds it on the way back. Which folders are open
// is arrangement, per workspace, like the pane tree it sits beside.
import {
  firstLeaf,
  makeNoteTab,
  makeTab,
  tabPaths,
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
import type { NoteMeta, TrashMeta, WorkspaceRootInfo } from "../../shared/rpc-schema";
import { expandedIn, seedExpansion } from "../notes/expansion";
import { folderList } from "../notes/folders";

// The persisted shape, version 2. Version 1 predates per-workspace folders and
// has no migration (the product is unreleased), so v1 text restores as null
// and boots fresh. Each workspace carries its notes `folder` (the opaque root
// handle from Bun) and its tabs as note paths. restoreNode opens only paths
// that folder's boot noteList also returned, so a hand-edited file cannot
// smuggle in another root's file.
//
// restore reads `expanded` defensively, since it arrived after the shape was
// named. A file written before it existed is a good version-2 file whose
// folders are all closed, and the build that wrote it opened with every folder
// closed too. Nothing to migrate, so no new version.
interface PersistedLeaf {
  kind: "leaf";
  tabs: string[];
  activeIndex: number;
  focused?: true;
  // The slot holding this pane's preview tab (interactions.md §1b), absent
  // when it has none. An index into `tabs`, like activeIndex, and read as
  // defensively: a file written before the field existed restores a strip of
  // ordinary tabs, which is what the build that wrote it had.
  preview?: number;
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
  folder: string;
  expanded: string[];
  root: PersistedNode;
}
interface PersistedLayout {
  version: 2;
  selectedIndex: number;
  workspaces: PersistedWorkspace[];
}

// Workspaces whose folder is registered but not on disk this session (an
// unmounted volume). restoreLayout drops them from the live AppState (nothing
// to show) and resets this list; serializeLayout writes them back verbatim. An
// unmounted volume costs this session's view, never the saved layout: the
// workspace comes back as it was after a remount and a relaunch.
let dormant: PersistedWorkspace[] = [];

/** A persisted list of strings, defensively: anything else is an empty one. */
function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
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
  // The active tab's slot among the kept tabs. When the active tab is itself
  // unsaved, and so not persisted, fall to the neighbour that slides into its
  // slot. That is closeTab's rule (store.tsx), and dropping the tab here is a
  // deferred close.
  let activeIndex = kept.findIndex((t) => t.id === node.activeTabId);
  if (activeIndex < 0) {
    const origIndex = node.tabs.findIndex((t) => t.id === node.activeTabId);
    const before = node.tabs.slice(0, Math.max(origIndex, 0)).filter((t) => t.path !== null).length;
    activeIndex = Math.min(before, Math.max(kept.length - 1, 0));
  }
  const preview = kept.findIndex((t) => t.preview);
  return {
    kind: "leaf",
    tabs: kept.map((t) => t.path as string),
    activeIndex,
    ...(node.id === focusedPaneId ? { focused: true as const } : {}),
    ...(preview >= 0 ? { preview } : {}),
  };
}

// Exported for unit tests; the app reaches it through scheduleLayoutSave.
export function serializeLayout(state: AppState): string {
  const layout: PersistedLayout = {
    version: 2,
    selectedIndex: Math.max(
      0,
      state.workspaces.findIndex((w) => w.id === state.selectedId),
    ),
    workspaces: [
      ...state.workspaces.map((ws) => ({
        name: ws.name,
        symbol: ws.symbol,
        folder: ws.folder,
        // Sorted so the text depends on the set rather than on the order it
        // was built in. Opening a, opening b and closing b leaves the same
        // folder open as opening a alone. An insertion-ordered list would make
        // that a byte change, and so a write of a layout that did not change.
        expanded: [...expandedIn(ws.folder)].sort(),
        root: persistNode(ws.root, ws.focusedPaneId),
      })),
      // The unmounted-volume workspaces follow the live ones, untouched, so
      // selectedIndex stays an index into what is on screen.
      ...dormant,
    ],
  };
  return JSON.stringify(layout);
}

// --- restore ----------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Rebuild one node, degrading per branch: a malformed half of a split costs
// that half (the sibling takes its place), and a whole malformed subtree costs
// the workspace. `byPath` holds only this workspace's folder's notes, which is
// what pins every restored tab inside its own folder. `opened` spans every
// workspace. A note open twice would be two docIds racing autosaves over one
// file: openNote rules that out while the app runs, and `opened` rules it out
// for a file that could have been duplicated by hand. `docs` marks the
// read-only documentation workspace, where a pane left with no page is not
// reseeded (splitPane's rule, held across a restart).
function restoreNode(
  raw: unknown,
  byPath: Map<string, NoteMeta>,
  opened: Set<string>,
  focus: { paneId: string | null },
  docs: boolean,
): PaneNode | null {
  if (!isRecord(raw)) return null;

  if (raw.kind === "split") {
    const children = Array.isArray(raw.children) ? raw.children : [];
    const a = restoreNode(children[0], byPath, opened, focus, docs);
    const b = restoreNode(children[1], byPath, opened, focus, docs);
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

  // Survivors: paths that are strings, still exist in this workspace's folder
  // (per its boot noteList, the only authority on paths), and are not already
  // open in a pane restored before this one. origIndex keys the active-tab
  // fixup below.
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

  // A pane whose every tab was pruned keeps its place in the tree and gets a
  // fresh scratch tab rather than the "No open notes" placeholder. A missing
  // note is no reason to collapse the layout, and removeTabsBy leaves an
  // emptied pane standing on the same grounds (tree.ts). The docs workspace
  // stays empty: a scratch tab there is a note that can never save.
  //
  // The preview slot is matched by its index in the FILE rather than its index
  // after pruning, so a pane whose preview tab is gone comes back with none and
  // nothing is promoted in its place (interactions.md §1b).
  const rawPreview = typeof raw.preview === "number" ? raw.preview : -1;
  const tabs: TabState[] =
    survivors.length > 0
      ? survivors.map((s) => makeNoteTab(s.meta.path, s.meta.title, s.origIndex === rawPreview))
      : docs
        ? []
        : [makeTab("scratch")];

  const leaf: LeafNode = {
    kind: "leaf",
    id: uid("pane"),
    tabs,
    activeTabId: tabs.length > 0 ? tabs[Math.min(active, tabs.length - 1)].id : "",
  };
  if (raw.focused === true && focus.paneId === null) focus.paneId = leaf.id;
  return leaf;
}

function restoreWorkspace(
  raw: unknown,
  folder: string,
  byPath: Map<string, NoteMeta>,
  opened: Set<string>,
  n: number,
  docs: boolean,
): Workspace | null {
  if (!isRecord(raw)) return null;
  const focus: { paneId: string | null } = { paneId: null };
  const root = restoreNode(raw.root, byPath, opened, focus, docs);
  if (!root) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `Workspace ${n}`;
  const symbol = typeof raw.symbol === "string" && isIconKey(raw.symbol) ? raw.symbol : DEFAULT_ICON;
  return { id: uid("ws"), name, symbol, folder, root, focusedPaneId: focus.paneId ?? firstLeaf(root).id };
}

// Keep a raw persisted workspace verbatim for re-serialization (the dormant
// path). This copies only the fields the shape owns, dropping anything else a
// hand-editor added, the same cleanup a live round trip does.
function keepDormant(raw: Record<string, unknown>, folder: string): void {
  dormant.push({
    name: typeof raw.name === "string" ? raw.name : "",
    symbol: typeof raw.symbol === "string" ? (raw.symbol as string) : DEFAULT_ICON,
    folder,
    expanded: stringList(raw.expanded),
    root: raw.root as PersistedNode,
  });
}

// Rebuild the boot AppState from the saved layout text, or null when nothing
// is restorable: no file yet, unparseable JSON, an unknown version, or no
// workspace surviving validation. Each workspace degrades on its own. A folder
// that is no longer registered costs its workspace. A folder that is
// registered but unavailable (an unmounted volume) stays dormant: out of the
// state, carried through saves. The caller falls back to initialState. This
// never throws, because the file it reads is machine-written and refusing to
// boot over it is not an acceptable failure.
// Exported for unit tests; the app goes through restoredState below.
export function restoreLayout(
  text: string | null,
  roots: WorkspaceRootInfo[],
  notesByFolder: Record<string, NoteMeta[]>,
  trashByFolder: Record<string, TrashMeta[]>,
): AppState | null {
  dormant = [];
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || json.version !== 2 || !Array.isArray(json.workspaces)) return null;

  const rootInfo = new Map(roots.map((r) => [r.root, r]));
  const byPathByFolder = new Map<string, Map<string, NoteMeta>>();
  for (const [folder, notes] of Object.entries(notesByFolder)) {
    byPathByFolder.set(folder, new Map(notes.map((m) => [m.path, m])));
  }

  const opened = new Set<string>();
  const workspaces: Workspace[] = [];
  for (const raw of json.workspaces) {
    if (!isRecord(raw) || typeof raw.folder !== "string") continue;
    const info = rootInfo.get(raw.folder);
    if (!info) continue; // unregistered folder: the workspace is gone
    if (!info.available) {
      keepDormant(raw, raw.folder); // unmounted volume: hold, don't prune
      continue;
    }
    const ws = restoreWorkspace(
      raw,
      raw.folder,
      byPathByFolder.get(raw.folder) ?? new Map(),
      opened,
      workspaces.length + 1,
      info.kind === "docs",
    );
    if (!ws) continue;
    // A docs workspace that restored with no page open is dropped rather than
    // kept. Its panes hold nothing (a scratch tab in the read-only docs folder
    // would be a note that can never save), and if it was the selected
    // workspace the app would boot into that blank with no strip row to say
    // where it is, which a real user hit. The help button opens the manual
    // again on Getting Started (commands/registry.ts docs.toggle).
    if (info.kind === "docs" && tabPaths(ws.root).length === 0) continue;
    workspaces.push(ws);
    // The open folders, pruned to the folders this workspace still has. The
    // authority is the boot noteList, the one that prunes a restored tab and
    // the list folderList derives the folder tree from. A folder deleted or
    // renamed from a shell while Ledge was closed comes back closed, like any
    // entry matching no row (notes/expansion.ts). Pruning keeps that entry out
    // of the file from then on.
    const live = new Set(folderList(notesByFolder[raw.folder] ?? []));
    seedExpansion(
      raw.folder,
      stringList(raw.expanded).filter((f) => live.has(f)),
    );
  }
  if (workspaces.length === 0) return null;

  const rawSelected = typeof json.selectedIndex === "number" ? json.selectedIndex : 0;
  const selected = workspaces[Math.max(0, Math.min(Math.floor(rawSelected), workspaces.length - 1))];
  const notes: Record<string, NoteMeta[]> = {};
  const trash: Record<string, TrashMeta[]> = {};
  for (const ws of workspaces) {
    notes[ws.folder] = notesByFolder[ws.folder] ?? [];
    trash[ws.folder] = trashByFolder[ws.folder] ?? [];
  }
  return { workspaces, selectedId: selected.id, notes, trash };
}

// The boot state: the saved session if it restores, else a fresh start on the
// first available workspace folder. boot.tsx and the harness both come through
// here, so the fallback rule lives here and not at every boot site. With no
// available folder at all (Bun unreachable, or a registry healed to empty
// before ensureDefault ran), the state has no folder: it renders but cannot
// save, the same degradation the old boot had with no note list.
export function restoredState(
  text: string | null,
  roots: WorkspaceRootInfo[],
  notesByFolder: Record<string, NoteMeta[]>,
  trashByFolder: Record<string, TrashMeta[]>,
): AppState {
  const restored = restoreLayout(text, roots, notesByFolder, trashByFolder);
  if (restored) return restored;
  // Never the docs root: a fresh start has to land somewhere a first note can
  // save, and the documentation folder is read-only. ensureDefault guarantees
  // a real folder exists whenever Bun was reachable at all.
  const first = roots.find((r) => r.available && r.kind !== "docs");
  const folder = first?.root ?? "";
  return initialState(folder, notesByFolder[folder] ?? [], trashByFolder[folder] ?? []);
}

// --- the save side ----------------------------------------------------------

// The layout channel, mirroring notes/channel.ts. boot.tsx binds save to the
// layoutSave RPC, and the harness binds it to memory. Unconfigured is a silent
// no-op rather than a throw: a missed layout save must never take the app
// down, and the debounce timer below fires with no caller left to catch
// anything.
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

// Called on every workspace-state change (App.tsx's effect). It serializes
// eagerly, which is cheap on trees this small. Identical states (focus bounced
// away and came back, say) then collapse to no write at all.
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

// Write the pending layout through now. Called by the timer, and on blur and
// pagehide alongside the note-autosave flush (App.tsx). Quitting inside the
// debounce window is the one exposure, the same one notes have.
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
