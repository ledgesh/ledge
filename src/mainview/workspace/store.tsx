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
import type { NoteMeta, TrashMeta } from "../../shared/rpc-schema";

export interface AppState {
  workspaces: Workspace[];
  selectedId: string;
  // Every note in ~/.ledge, as the note browser and quick-open palette see it.
  // Held in listNotes order (most recently modified first) because that is what
  // picks the note to open at boot; the browser sorts a copy by title for
  // display, since re-sorting by mtime would make rows jump around as you type.
  notes: NoteMeta[];
  // The deleted notes still sitting in ~/.ledge/.trash, newest deletion first.
  // Held here rather than fetched by the Trash section when it opens, so the
  // count shows on the collapsed header: a trash you have to open to discover
  // is the one we already had, and it filled up silently.
  trash: TrashMeta[];
}

function makeWorkspace(name: string, tab: TabState): Workspace {
  const leaf = makeLeaf(tab);
  return { id: uid("ws"), name, symbol: DEFAULT_ICON, root: leaf, focusedPaneId: leaf.id };
}

// The launch state, built from the notes already on disk (newest first, as
// listNotes returns them). The pane layout is not persisted yet, so a launch
// opens exactly one note: the one you edited last, or the demo note when the
// notes folder is empty. That demo note is unsaved like any other new note, so a
// first launch you do not type in still leaves the folder empty.
//
// Exported for unit tests (store.test.ts); the app goes through WorkspaceProvider.
export function initialState(notes: NoteMeta[] = [], trash: TrashMeta[] = []): AppState {
  const newest = notes[0];
  const tab = newest ? makeNoteTab(newest.path, newest.title) : makeTab("demo", "Welcome");
  const first = makeWorkspace("Scratch", tab);
  return { workspaces: [first], selectedId: first.id, notes, trash };
}

// --- actions ---------------------------------------------------------------

export type Action =
  | { type: "selectWorkspace"; id: string }
  | { type: "newWorkspace" }
  | { type: "closeWorkspace"; id: string }
  | { type: "renameWorkspace"; id: string; name: string }
  | { type: "setWorkspaceIcon"; id: string; symbol: string }
  | { type: "moveWorkspace"; id: string; toIndex: number }
  | { type: "focusPane"; paneId: string }
  | { type: "newTab"; paneId?: string }
  | { type: "closeTab"; paneId: string; tabId: string }
  | { type: "selectTab"; paneId: string; tabId: string }
  | { type: "moveTab"; fromPaneId: string; tabId: string; toPaneId: string; toIndex: number }
  | { type: "splitPane"; dir: SplitDir; paneId?: string }
  | { type: "closePane"; paneId?: string }
  | { type: "setRatio"; splitId: string; ratio: number }
  // A note's first save allocated it a file. Fired from notes/store.ts, so the
  // tab picks up its path and shows the filename it was saved under.
  | { type: "noteCreated"; docId: string; note: NoteMeta }
  // Open a note from the browser or the palette, or focus its tab if it is
  // already open somewhere.
  | { type: "openNote"; note: NoteMeta }
  // The notes folder was re-read (at window focus). Replaces the known list.
  | { type: "notesLoaded"; notes: NoteMeta[] }
  // A note's file moved. `path` is where it was; `note` is where it is now. Fired
  // from notes/actions.ts once Bun has done the rename, never before: the tab must
  // not show a name the file does not have.
  | { type: "noteRenamed"; path: string; note: NoteMeta }
  // A note's file is gone (trashed). Closes its tabs wherever they are.
  | { type: "noteDeleted"; path: string }
  // The trash was re-read (at boot and at every folder refresh).
  | { type: "trashLoaded"; items: TrashMeta[] }
  // A trashed note came back, via Undo or the Restore button. `note` is where it
  // landed, which need not be where it was deleted from: its old name may have
  // been taken since. Its tabs are NOT reopened; it simply rejoins the browser.
  | { type: "noteRestored"; note: NoteMeta }
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

// Exported for unit tests (store.test.ts).
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "selectWorkspace":
      return state.workspaces.some((w) => w.id === action.id)
        ? { ...state, selectedId: action.id }
        : state;

    case "newWorkspace": {
      const n = state.workspaces.length + 1;
      const ws = makeWorkspace(`Workspace ${n}`, makeTab("scratch"));
      return { ...state, workspaces: [...state.workspaces, ws], selectedId: ws.id };
    }

    case "closeWorkspace": {
      if (state.workspaces.length <= 1) return state;
      const idx = state.workspaces.findIndex((w) => w.id === action.id);
      if (idx < 0) return state;
      const workspaces = state.workspaces.filter((w) => w.id !== action.id);
      const selectedId =
        state.selectedId === action.id
          ? workspaces[Math.min(idx, workspaces.length - 1)].id
          : state.selectedId;
      return { ...state, workspaces, selectedId };
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
      // An unknown key would render as the default anyway (iconFor), so storing
      // one would silently pretend the choice took.
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
        // A fresh split gets its own scratch tab; an empty pane is a dead grey
        // rectangle, so every new pane is seeded (matches the Swift build).
        const newLeaf = makeLeaf(makeTab("scratch"));
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
      // Not withSelected: a save can land while you are in another workspace, and
      // the tab that owns the docId is wherever it has been dragged to by now.
      let touched = false;
      const workspaces = state.workspaces.map((ws) => {
        const root = mapTabs(ws.root, (t) =>
          t.docId === action.docId ? { ...t, path: action.note.path, title: action.note.title } : t,
        );
        if (root === ws.root) return ws;
        touched = true;
        return { ...ws, root };
      });
      // The new file belongs in the browser immediately, not at the next refresh.
      // Newest first, matching listNotes order.
      const known = state.notes.some((n) => n.path === action.note.path);
      const notes = known ? state.notes : [action.note, ...state.notes];
      return touched || !known ? { ...state, workspaces, notes } : state;
    }

    case "notesLoaded":
      return { ...state, notes: action.notes };

    case "noteRenamed": {
      // The docId is untouched, so the editor, its undo history, and the note's
      // shells carry straight through the rename: only the path and the tab label
      // move. That separation is the whole reason the two are different keys.
      const workspaces = state.workspaces.map((ws) => {
        const root = mapTabs(ws.root, (t) =>
          t.path === action.path ? { ...t, path: action.note.path, title: action.note.title } : t,
        );
        return root === ws.root ? ws : { ...ws, root };
      });
      const notes = state.notes.map((n) => (n.path === action.path ? action.note : n));
      return { ...state, workspaces, notes };
    }

    case "noteTitled": {
      // The tab is found by docId (the live session), and the browser row by the
      // path that tab holds: one edit, both surfaces, so the list does not sit on
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
        : state.notes.map((n) => (n.path === path ? { ...n, title: action.label } : n));
      return { ...state, workspaces, notes };
    }

    case "noteDeleted": {
      const workspaces = state.workspaces.map((ws) => {
        const root = removeTabsBy(ws.root, (t) => t.path === action.path);
        return root === ws.root ? ws : { ...ws, root };
      });
      // Closing the tabs is what drops their docIds out of the live set, which is
      // what App's reconciliation effect turns into an editor teardown and a
      // closeSession for the note's shells.
      return { ...state, workspaces, notes: state.notes.filter((n) => n.path !== action.path) };
    }

    case "trashLoaded":
      return { ...state, trash: action.items };

    case "noteRestored": {
      if (state.notes.some((n) => n.path === action.note.path)) return state;
      // Re-sorted rather than pushed to the front: a restored note keeps its real
      // last-edited time (the trash records the deletion in ctime and leaves mtime
      // alone), so it belongs wherever that puts it. This list is held in listNotes
      // order, and a refresh would put it there anyway.
      const notes = [...state.notes, action.note].sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { ...state, notes };
    }

    case "openNote": {
      // Already open? Focus that tab wherever it lives, rather than opening the
      // note twice: two tabs on one path means two docIds, two editors, and two
      // autosaves racing to write the same file.
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

// `initial` is built at boot from the notes on disk (main.tsx), so the first
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
// reach every one of them, and asking the tree beats assuming.
export function docIdsForPath(state: AppState, path: string): string[] {
  return state.workspaces.flatMap((ws) => tabsBy(ws.root, (t) => t.path === path).map((t) => t.docId));
}

export type { PaneNode, Workspace };
