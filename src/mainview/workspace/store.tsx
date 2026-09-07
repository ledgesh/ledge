import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import {
  findLeaf,
  findTabBy,
  firstLeaf,
  leafIds,
  makeLeaf,
  makeNoteTab,
  makeTab,
  mapTabs,
  moveTab,
  removeLeaf,
  removeTabsBy,
  setRatio,
  splitLeaf,
  tabDocIds,
  tabPaths,
  tabsBy,
  updateLeaf,
  uid,
  type PaneNode,
  type SplitDir,
  type TabState,
  type Workspace,
} from "./tree";
import { DEFAULT_ICON, isIconKey } from "./icons";
import { WELCOME_TITLE } from "./seeds";
import type { NoteMeta, TrashMeta } from "../../shared/rpc-schema";

export interface AppState {
  workspaces: Workspace[];
  selectedId: string;
  // Every known note, keyed by workspace folder: a fact about the folder, and
  // the key persist.ts saves. The note browser and quick-open palette read
  // the selected workspace's list, in listNotes order (newest first), which
  // picks the note to open at boot. The browser sorts a copy by title, since
  // autosave rewrites mtime on each keystroke burst and rows would shuffle.
  notes: Record<string, NoteMeta[]>;
  // Each workspace folder's deleted notes, still in its .ledge-trash, newest
  // deletion first. Held here rather than fetched when the Trash section
  // opens, so the count shows on the collapsed header.
  trash: Record<string, TrashMeta[]>;
}

// Total selectors: an unknown folder is an empty list, never undefined, so
// components and command `when`s stay branch-free.
export function notesOf(state: AppState, folder: string): NoteMeta[] {
  return state.notes[folder] ?? [];
}
export function trashOf(state: AppState, folder: string): TrashMeta[] {
  return state.trash[folder] ?? [];
}

function makeWorkspace(name: string, folder: string, tab: TabState): Workspace {
  const leaf = makeLeaf(tab);
  return { id: uid("ws"), name, symbol: DEFAULT_ICON, folder, root: leaf, focusedPaneId: leaf.id };
}

// The fresh-start launch state: one workspace on `folder`, one tab. The tab
// holds the most recently edited note (`notes` arrives in listNotes order,
// newest first), or the welcome note (workspace/seeds.ts) when the folder is
// empty. The welcome note is unsaved like any other new note, so the folder
// is still empty after a first launch with no typing in it.
//
// This is the fallback, not the normal boot: a saved session restores through
// workspace/persist.ts, whose restoredState calls this whenever restoreLayout
// returns null (no file yet, text it cannot use, or no saved workspace still
// registered). Exported for unit tests (store.test.ts); the app goes through
// WorkspaceProvider.
export function initialState(folder: string, notes: NoteMeta[] = [], trash: TrashMeta[] = []): AppState {
  const newest = notes[0];
  const tab = newest ? makeNoteTab(newest.path, newest.title) : makeTab("demo", WELCOME_TITLE);
  const first = makeWorkspace("Scratch", folder, tab);
  return {
    workspaces: [first],
    selectedId: first.id,
    notes: { [folder]: notes },
    trash: { [folder]: trash },
  };
}

/**
 * The page the manual opens on: the page asked for by title, or Getting
 * Started when `page` is empty. A title that matches nothing (a corpus that
 * changed under a stale docs root) falls back to the first page in path
 * order. The pages are numbered (bun/docsContent.ts), so that is the reading
 * order.
 *
 * Undefined only when the folder listed no notes at all. Callers render that
 * as an empty pane rather than a scratch tab: the docs folder refuses writes,
 * so an Untitled there could never save.
 */
export function docsLanding(notes: NoteMeta[], page = ""): NoteMeta | undefined {
  const wanted = (page || "getting started").toLowerCase();
  return (
    notes.find((n) => n.title.toLowerCase() === wanted) ??
    [...notes].sort((a, b) => a.path.localeCompare(b.path))[0]
  );
}

/**
 * The manual window's launch state: one workspace, one page, nothing else
 * (remote.md §8a).
 *
 * `initialState`'s sibling, a boot state built from one folder and its notes,
 * for the window that shows only the manual. The saved layout is neither read
 * nor written: bun/index.ts no-ops `layoutGet` and `layoutSave` for this
 * window, and `page` decides what it opens on.
 */
export function docsState(folder: string, notes: NoteMeta[], page = ""): AppState {
  const start = docsLanding(notes, page);
  const leaf = makeLeaf(start ? makeNoteTab(start.path, start.title) : undefined);
  const ws: Workspace = {
    id: uid("ws"),
    name: "Documentation",
    symbol: DEFAULT_ICON,
    folder,
    root: leaf,
    focusedPaneId: leaf.id,
  };
  return { workspaces: [ws], selectedId: ws.id, notes: { [folder]: notes }, trash: { [folder]: [] } };
}

// --- actions ---------------------------------------------------------------

export type Action =
  | { type: "selectWorkspace"; id: string }
  // A workspace whose folder Bun just created or attached (workspace/actions.ts
  // did the round trip; the reducer stays pure). One workspace per folder: a
  // folder some workspace already owns is selected, not duplicated. `note`
  // seeds the first tab with an existing note rather than a scratch tab, so
  // opening the docs lands on Getting Started, not on an unsavable Untitled.
  | { type: "addWorkspace"; name: string; folder: string; note?: NoteMeta }
  | { type: "closeWorkspace"; id: string }
  // A workspace's folder moved on disk (Bun renamed it; workspace/actions.ts
  // did the round trip). Every open tab's path named the old folder, so the
  // pane tree resets to one scratch tab. The workspace keeps its id, name,
  // icon and strip position. App's reconciliation effect gives the dropped
  // docIds the editor teardown and closeSession calls every close path gets.
  // The files on disk are untouched.
  | { type: "workspaceFolderMoved"; id: string; folder: string }
  | { type: "renameWorkspace"; id: string; name: string }
  | { type: "setWorkspaceIcon"; id: string; symbol: string }
  | { type: "moveWorkspace"; id: string; toIndex: number }
  | { type: "focusPane"; paneId: string }
  | { type: "newTab"; paneId?: string }
  | { type: "closeTab"; paneId: string; tabId: string }
  | { type: "selectTab"; paneId: string; tabId: string }
  | { type: "moveTab"; fromPaneId: string; tabId: string; toPaneId: string; toIndex: number }
  // `empty` splits without seeding the new pane a scratch tab. A scratch tab
  // in the read-only docs workspace could never be saved, so
  // commands/registry.ts sets the flag when that workspace is selected.
  | { type: "splitPane"; dir: SplitDir; paneId?: string; empty?: boolean }
  | { type: "closePane"; paneId?: string }
  | { type: "setRatio"; splitId: string; ratio: number }
  // A note's first save allocated it a file in `folder` (the tab's workspace).
  // Fired from notes/store.ts via PaneTree, so the tab picks up its path and
  // shows the filename it was saved under.
  | { type: "noteCreated"; docId: string; folder: string; note: NoteMeta }
  // Open a note from the browser or the palette, or focus its tab if it is
  // already open somewhere.
  | { type: "openNote"; note: NoteMeta }
  // One workspace folder was re-read (at window focus). Replaces that folder's
  // known list and no other's.
  | { type: "notesLoaded"; folder: string; notes: NoteMeta[] }
  // A note's file moved. `path` is where it was; `note` is where it is now.
  // Two things fire it: a retitle (the filename following the H1) and a move
  // into another folder (notes/actions.ts moveNoteTo). Never before Bun has
  // done the rename: the tab must not show a name the file does not have.
  | { type: "noteRenamed"; path: string; note: NoteMeta }
  // A note's file is gone (trashed). Closes its tabs wherever they are.
  | { type: "noteDeleted"; path: string }
  // One workspace folder's trash was re-read (at boot and at every refresh).
  | { type: "trashLoaded"; folder: string; items: TrashMeta[] }
  // A note joined a workspace's list without a tab in this app having written
  // it: a trashed note came back (Undo, or the Restore button), or a command
  // created one outright (New Folder…, New Note in Folder, the starter
  // template). `note` is where it landed, under a name that need not be the
  // one asked for: an existing name may have been taken. No tab opens here,
  // so callers that want it on screen dispatch openNote too. The watcher's
  // refresh would bring the row in later, after the note it names is open.
  | { type: "noteAppeared"; folder: string; note: NoteMeta }
  // What a note is called on screen changed: its H1 was edited (or removed, and
  // the label fell back to the filename). Separate from noteRenamed because a
  // heading can change without the slug changing, and then no file moves at all.
  | { type: "noteTitled"; docId: string; label: string };

// Rewrite the selected workspace via `fn`; workspace-list actions are handled
// separately below.
function withSelected(state: AppState, fn: (ws: Workspace) => Workspace): AppState {
  return {
    ...state,
    workspaces: state.workspaces.map((ws) => (ws.id === state.selectedId ? fn(ws) : ws)),
  };
}

// Rewrite every folder's note list via `fn`, preserving identity when nothing
// changed. Paths are globally unique (each note lives under exactly one
// folder), so a per-path update needs no folder key from the caller. The scan
// is over a handful of small lists.
function mapNoteLists(
  lists: Record<string, NoteMeta[]>,
  fn: (n: NoteMeta) => NoteMeta | null,
): Record<string, NoteMeta[]> {
  let touched = false;
  const out: Record<string, NoteMeta[]> = {};
  for (const [folder, notes] of Object.entries(lists)) {
    let changed = false;
    const next: NoteMeta[] = [];
    for (const n of notes) {
      const m = fn(n);
      if (m !== n) changed = true;
      if (m !== null) next.push(m);
    }
    out[folder] = changed ? next : notes;
    if (changed) touched = true;
  }
  return touched ? out : lists;
}

// Exported for unit tests (store.test.ts).
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "selectWorkspace":
      return state.workspaces.some((w) => w.id === action.id)
        ? { ...state, selectedId: action.id }
        : state;

    case "addWorkspace": {
      // One workspace per folder: attaching a folder that is already a
      // workspace selects the existing one, the way openNote focuses a tab
      // that is already open.
      const existing = state.workspaces.find((w) => w.folder === action.folder);
      if (existing) return { ...state, selectedId: existing.id };
      const tab = action.note ? makeNoteTab(action.note.path, action.note.title) : makeTab("scratch");
      const ws = makeWorkspace(action.name, action.folder, tab);
      return {
        ...state,
        workspaces: [...state.workspaces, ws],
        selectedId: ws.id,
        // Seed the folder's lists if boot did not already know it (a freshly
        // created folder is empty; an attached one is loaded right after by
        // workspace/actions.ts).
        notes: state.notes[action.folder] ? state.notes : { ...state.notes, [action.folder]: [] },
        trash: state.trash[action.folder] ? state.trash : { ...state.trash, [action.folder]: [] },
      };
    }

    case "closeWorkspace": {
      if (state.workspaces.length <= 1) return state;
      const idx = state.workspaces.findIndex((w) => w.id === action.id);
      if (idx < 0) return state;
      const closing = state.workspaces[idx];
      const workspaces = state.workspaces.filter((w) => w.id !== action.id);
      const selectedId =
        state.selectedId === action.id
          ? workspaces[Math.min(idx, workspaces.length - 1)].id
          : state.selectedId;
      // Drop the folder's lists with it (one workspace per folder, so nothing
      // else reads them). The files stay on disk; only this state drops them.
      const notes = { ...state.notes };
      const trash = { ...state.trash };
      delete notes[closing.folder];
      delete trash[closing.folder];
      return { ...state, workspaces, selectedId, notes, trash };
    }

    case "workspaceFolderMoved": {
      const ws = state.workspaces.find((w) => w.id === action.id);
      if (!ws || ws.folder === action.folder) return state;
      // One workspace per folder still holds. Bun refuses nested and duplicate
      // destinations, so a collision here is a stale dispatch: drop it.
      if (state.workspaces.some((w) => w.folder === action.folder)) return state;
      const leaf = makeLeaf(makeTab("scratch"));
      const workspaces = state.workspaces.map((w) =>
        w.id === action.id ? { ...w, folder: action.folder, root: leaf, focusedPaneId: leaf.id } : w,
      );
      // The old folder's lists go the way closeWorkspace's do; the new
      // folder's are seeded empty and refreshed by the caller right after.
      const notes = { ...state.notes };
      const trash = { ...state.trash };
      delete notes[ws.folder];
      delete trash[ws.folder];
      return {
        ...state,
        workspaces,
        notes: { ...notes, [action.folder]: notes[action.folder] ?? [] },
        trash: { ...trash, [action.folder]: trash[action.folder] ?? [] },
      };
    }

    case "renameWorkspace": {
      const name = action.name.trim();
      if (!name) return state;
      return {
        ...state,
        workspaces: state.workspaces.map((w) => (w.id === action.id ? { ...w, name } : w)),
      };
    }

    case "setWorkspaceIcon": {
      // An unknown key renders as the default anyway (icons.ts iconFor), so
      // storing one would leave the row drawing the default icon.
      if (!isIconKey(action.symbol)) return state;
      return {
        ...state,
        workspaces: state.workspaces.map((w) =>
          w.id === action.id ? { ...w, symbol: action.symbol } : w,
        ),
      };
    }

    case "moveWorkspace": {
      const from = state.workspaces.findIndex((w) => w.id === action.id);
      if (from < 0) return state;
      // `toIndex` counts the strip as displayed at drop time, so the list still
      // contains the dragged row: an index past its own slot shifts down one
      // after removal (the same bookkeeping moveTab does within a pane).
      const without = state.workspaces.filter((w) => w.id !== action.id);
      const idx = Math.max(0, Math.min(action.toIndex > from ? action.toIndex - 1 : action.toIndex, without.length));
      if (idx === from) return state; // dropped back onto its own slot
      const workspaces = [...without.slice(0, idx), state.workspaces[from], ...without.slice(idx)];
      return { ...state, workspaces };
    }

    case "focusPane":
      return withSelected(state, (ws) =>
        ws.focusedPaneId === action.paneId || !findLeaf(ws.root, action.paneId)
          ? ws
          : { ...ws, focusedPaneId: action.paneId },
      );

    case "newTab":
      return withSelected(state, (ws) => {
        const paneId = action.paneId ?? ws.focusedPaneId;
        const tab = makeTab("scratch");
        const root = updateLeaf(ws.root, paneId, (leaf) => ({
          ...leaf,
          tabs: [...leaf.tabs, tab],
          activeTabId: tab.id,
        }));
        return { ...ws, root, focusedPaneId: paneId };
      });

    case "selectTab":
      return withSelected(state, (ws) => ({
        ...ws,
        focusedPaneId: action.paneId,
        root: updateLeaf(ws.root, action.paneId, (leaf) =>
          leaf.tabs.some((t) => t.id === action.tabId) ? { ...leaf, activeTabId: action.tabId } : leaf,
        ),
      }));

    case "closeTab":
      return withSelected(state, (ws) => ({
        ...ws,
        root: updateLeaf(ws.root, action.paneId, (leaf) => {
          const idx = leaf.tabs.findIndex((t) => t.id === action.tabId);
          if (idx < 0) return leaf;
          const tabs = leaf.tabs.filter((t) => t.id !== action.tabId);
          let activeTabId = leaf.activeTabId;
          if (activeTabId === action.tabId) {
            // Fall to the neighbour that slid into this slot, else the new last.
            const next = tabs[idx] ?? tabs[idx - 1];
            activeTabId = next ? next.id : "";
          }
          return { ...leaf, tabs, activeTabId };
        }),
      }));

    case "moveTab":
      return withSelected(state, (ws) => {
        const root = moveTab(ws.root, action.fromPaneId, action.tabId, action.toPaneId, action.toIndex);
        if (root === ws.root) return ws;
        // The destination pane gains focus, as if the moved tab were clicked there.
        return { ...ws, root, focusedPaneId: action.toPaneId };
      });

    case "splitPane":
      return withSelected(state, (ws) => {
        const paneId = action.paneId ?? ws.focusedPaneId;
        if (!findLeaf(ws.root, paneId)) return ws;
        // Every new pane is seeded a scratch tab, so none opens blank
        // (matching the Swift build), except in the read-only docs workspace:
        // an "Untitled" there could not be typed in or saved, so its splits
        // open onto the empty state instead.
        const newLeaf = makeLeaf(action.empty ? undefined : makeTab("scratch"));
        const root = splitLeaf(ws.root, paneId, action.dir, newLeaf);
        return { ...ws, root, focusedPaneId: newLeaf.id };
      });

    case "closePane":
      return withSelected(state, (ws) => {
        const paneId = action.paneId ?? ws.focusedPaneId;
        if (leafIds(ws.root).length <= 1) return ws; // can't close the last pane
        const root = removeLeaf(ws.root, paneId);
        if (root === ws.root) return ws;
        const focusedPaneId = firstLeaf(root).id;
        return { ...ws, root, focusedPaneId };
      });

    case "setRatio":
      return withSelected(state, (ws) => ({
        ...ws,
        root: setRatio(ws.root, action.splitId, clampRatio(action.ratio)),
      }));

    case "noteCreated": {
      // Not withSelected: a save can land while another workspace is selected,
      // and the tab that owns the docId may have been dragged anywhere by now.
      let touched = false;
      const workspaces = state.workspaces.map((ws) => {
        const root = mapTabs(ws.root, (t) =>
          t.docId === action.docId ? { ...t, path: action.note.path, title: action.note.title } : t,
        );
        if (root === ws.root) return ws;
        touched = true;
        return { ...ws, root };
      });
      // The new file belongs in its folder's browser immediately, not at the
      // next refresh. Newest first, matching listNotes order.
      const list = state.notes[action.folder] ?? [];
      const known = list.some((n) => n.path === action.note.path);
      const notes = known ? state.notes : { ...state.notes, [action.folder]: [action.note, ...list] };
      return touched || !known ? { ...state, workspaces, notes } : state;
    }

    case "notesLoaded":
      return { ...state, notes: { ...state.notes, [action.folder]: action.notes } };

    case "noteRenamed": {
      // The docId is untouched, so the editor, its undo history and the note's
      // shells carry straight through the rename. Only the path and the tab
      // label move, which is why path and docId are separate keys (tree.ts).
      const workspaces = state.workspaces.map((ws) => {
        const root = mapTabs(ws.root, (t) =>
          t.path === action.path ? { ...t, path: action.note.path, title: action.note.title } : t,
        );
        return root === ws.root ? ws : { ...ws, root };
      });
      // The row is replaced wherever its old path is found (paths are globally
      // unique) by the whole new meta. That meta carries the new folder, so a
      // move regroups the note in the browser's tree without a folder refresh.
      const notes = mapNoteLists(state.notes, (n) => (n.path === action.path ? action.note : n));
      return { ...state, workspaces, notes };
    }

    case "noteTitled": {
      // The tab is found by docId (the live session), and the browser row by
      // the path that tab holds. Updating both here stops the browser showing
      // a stale heading until the next folder refresh.
      let path: string | null = null;
      const workspaces = state.workspaces.map((ws) => {
        const root = mapTabs(ws.root, (t) => {
          if (t.docId !== action.docId) return t;
          path = t.path;
          return t.title === action.label ? t : { ...t, title: action.label };
        });
        return root === ws.root ? ws : { ...ws, root };
      });
      const notes = path === null
        ? state.notes
        : mapNoteLists(state.notes, (n) => (n.path === path ? { ...n, title: action.label } : n));
      return { ...state, workspaces, notes };
    }

    case "noteDeleted": {
      const workspaces = state.workspaces.map((ws) => {
        const root = removeTabsBy(ws.root, (t) => t.path === action.path);
        return root === ws.root ? ws : { ...ws, root };
      });
      // Closing the tabs drops their docIds out of the live set. App's
      // reconciliation effect then tears down the editor and calls
      // closeSession for the note's shells.
      return { ...state, workspaces, notes: mapNoteLists(state.notes, (n) => (n.path === action.path ? null : n)) };
    }

    case "trashLoaded":
      return { ...state, trash: { ...state.trash, [action.folder]: action.items } };

    case "noteAppeared": {
      const list = state.notes[action.folder] ?? [];
      if (list.some((n) => n.path === action.note.path)) return state;
      // Re-sorted rather than pushed to the front. A restored note keeps its
      // real last-edited time (the trash records the deletion in ctime and
      // leaves mtime alone), so it belongs wherever that puts it. The list is
      // held in listNotes order, and a refresh would put it there anyway.
      const notes = {
        ...state.notes,
        [action.folder]: [...list, action.note].sort((a, b) => b.mtimeMs - a.mtimeMs),
      };
      return { ...state, notes };
    }

    case "openNote": {
      // A note already open is not opened twice. The loop below focuses its
      // existing tab wherever it lives: two tabs on one path would be two
      // docIds, two editors, and two autosaves racing to write the same file.
      for (const ws of state.workspaces) {
        const hit = findTabBy(ws.root, (t) => t.path === action.note.path);
        if (!hit) continue;
        return {
          ...state,
          selectedId: ws.id,
          workspaces: state.workspaces.map((w) =>
            w.id === ws.id
              ? {
                  ...w,
                  focusedPaneId: hit.paneId,
                  root: updateLeaf(w.root, hit.paneId, (leaf) => ({ ...leaf, activeTabId: hit.tabId })),
                }
              : w,
          ),
        };
      }
      // Not open: a new tab in the selected workspace's focused pane.
      return withSelected(state, (ws) => {
        const paneId = ws.focusedPaneId;
        if (!findLeaf(ws.root, paneId)) return ws;
        const tab = makeNoteTab(action.note.path, action.note.title);
        const root = updateLeaf(ws.root, paneId, (leaf) => ({
          ...leaf,
          tabs: [...leaf.tabs, tab],
          activeTabId: tab.id,
        }));
        return { ...ws, root, focusedPaneId: paneId };
      });
    }

    default:
      return state;
  }
}

function clampRatio(r: number): number {
  return Math.max(0.12, Math.min(0.88, r));
}

// --- context ---------------------------------------------------------------

interface Store {
  state: AppState;
  dispatch: (action: Action) => void;
  selected: Workspace;
}

const WorkspaceContext = createContext<Store | null>(null);

// `initial` is built at boot from the notes on disk (boot.tsx), so the first
// render already has the right note in its tab: no empty-then-populate flash.
export function WorkspaceProvider({ initial, children }: { initial: AppState; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const selected = useMemo(
    () => state.workspaces.find((w) => w.id === state.selectedId) ?? state.workspaces[0],
    [state],
  );
  const value = useMemo(() => ({ state, dispatch, selected }), [state, selected]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Store {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}

// Every docId currently referenced by any workspace. App diffs this against the
// previous set to release editors whose tab (or pane, or workspace) was closed.
export function allDocIds(state: AppState): string[] {
  return state.workspaces.flatMap((ws) => tabDocIds(ws.root));
}

// Every note file open in a tab anywhere. The browser marks these rows as open.
export function openNotePaths(state: AppState): Set<string> {
  return new Set(state.workspaces.flatMap((ws) => tabPaths(ws.root)));
}

// The live sessions a note is open under. Normally one (openNote focuses an
// existing tab rather than opening a second), but a rename or a delete has to
// reach every one, so this scans the tree instead of assuming there is one.
export function docIdsForPath(state: AppState, path: string): string[] {
  return state.workspaces.flatMap((ws) => tabsBy(ws.root, (t) => t.path === path).map((t) => t.docId));
}

export type { PaneNode, Workspace };
