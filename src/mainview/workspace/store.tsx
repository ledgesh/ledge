import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import {
  findLeaf,
  firstLeaf,
  leafIds,
  makeLeaf,
  makeTab,
  removeLeaf,
  setRatio,
  splitLeaf,
  tabDocIds,
  updateLeaf,
  uid,
  type PaneNode,
  type SplitDir,
  type Workspace,
} from "./tree";

// Icons a new workspace cycles through (keys resolved in Sidebar.tsx).
const WORKSPACE_SYMBOLS = ["inbox", "layers", "boxes", "folder", "terminal"];

export interface AppState {
  workspaces: Workspace[];
  selectedId: string;
}

function makeWorkspace(name: string, symbol: string, seed: "demo" | "scratch"): Workspace {
  const leaf = makeLeaf(makeTab(seed, seed === "demo" ? "Welcome" : "Untitled"));
  return { id: uid("ws"), name, symbol, root: leaf, focusedPaneId: leaf.id };
}

function initialState(): AppState {
  const first = makeWorkspace("Scratch", "inbox", "demo");
  return { workspaces: [first], selectedId: first.id };
}

// --- actions ---------------------------------------------------------------

export type Action =
  | { type: "selectWorkspace"; id: string }
  | { type: "newWorkspace" }
  | { type: "closeWorkspace"; id: string }
  | { type: "renameWorkspace"; id: string; name: string }
  | { type: "focusPane"; paneId: string }
  | { type: "newTab"; paneId?: string }
  | { type: "closeTab"; paneId: string; tabId: string }
  | { type: "selectTab"; paneId: string; tabId: string }
  | { type: "splitPane"; dir: SplitDir; paneId?: string }
  | { type: "closePane"; paneId?: string }
  | { type: "setRatio"; splitId: string; ratio: number };

// Rewrite the selected workspace via `fn`; workspace-list actions are handled
// separately below.
function withSelected(state: AppState, fn: (ws: Workspace) => Workspace): AppState {
  return {
    ...state,
    workspaces: state.workspaces.map((ws) => (ws.id === state.selectedId ? fn(ws) : ws)),
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "selectWorkspace":
      return state.workspaces.some((w) => w.id === action.id)
        ? { ...state, selectedId: action.id }
        : state;

    case "newWorkspace": {
      const n = state.workspaces.length + 1;
      const ws = makeWorkspace(`Workspace ${n}`, WORKSPACE_SYMBOLS[n % WORKSPACE_SYMBOLS.length], "scratch");
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
      return { workspaces, selectedId };
    }

    case "renameWorkspace": {
      const name = action.name.trim();
      if (!name) return state;
      return {
        ...state,
        workspaces: state.workspaces.map((w) => (w.id === action.id ? { ...w, name } : w)),
      };
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

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
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

export type { PaneNode, Workspace };
