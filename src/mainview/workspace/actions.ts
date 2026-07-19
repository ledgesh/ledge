// The workspace operations that need a Bun round trip before the reducer can
// act, mirroring notes/actions.ts: the reducer stays pure, so creating a
// folder, opening the attach dialog, and detaching a closed workspace's folder
// all orchestrate here.
import { listNotes, listTrash } from "../notes/channel";
import { flushAllNow } from "../notes/store";
import {
  attachWorkspaceFolder as attachFolder,
  createWorkspaceFolder,
  detachWorkspaceFolder,
  docsFolder,
  moveWorkspaceFolder,
  workspaceKind,
} from "./channel";
import { notesOf, type Action, type AppState } from "./store";
import { tabPaths } from "./tree";

// New Workspace: ask Bun for a folder first (it slugs the display name and
// allocates against what exists), then add the workspace over it. The name
// counts existing workspaces the way the old pure action did, so the strip
// still reads Workspace 2, Workspace 3, ...
export async function createWorkspace(
  state: AppState,
  dispatch: (action: Action) => void,
): Promise<string | null> {
  const name = `Workspace ${state.workspaces.length + 1}`;
  try {
    const folder = await createWorkspaceFolder(name);
    dispatch({ type: "addWorkspace", name, folder });
    return null;
  } catch (err) {
    console.error("[workspace] create failed", err);
    return err instanceof Error ? err.message : String(err);
  }
}

// Attach Folder as Workspace: the native picker runs Bun-side; all the view
// gets back is a root handle (or a refusal). Cancelling costs nothing. An
// already-attached folder selects its existing workspace (the reducer's
// one-workspace-per-folder rule). The workspace is named after the folder —
// the last path segment is what the user just picked it by — and its lists
// are fetched right away so the browser is not empty until the next refresh.
export async function attachWorkspace(
  dispatch: (action: Action) => void,
): Promise<string | null> {
  let res: Awaited<ReturnType<typeof attachFolder>>;
  try {
    res = await attachFolder();
  } catch (err) {
    console.error("[workspace] attach failed", err);
    return err instanceof Error ? err.message : String(err);
  }
  if (res.error !== null) return res.error;
  if (res.root === null) return null; // cancelled
  const folder = res.root;
  dispatch({ type: "addWorkspace", name: folder.split("/").pop() || folder, folder });
  await refreshFolder(folder, dispatch);
  return null;
}

// Open the built-in Documentation workspace: select it if it is already open,
// else add it over the docs folder Bun reported at boot, landing on the
// Getting Started page (else the first page in path order — the browser's
// order for docs: the manifest's numbered filenames, bun/docsContent.ts).
// The page list comes from the store when a restored session already
// carries it, else one listNotes round trip: the fresh-start boot seeds only
// the first workspace's lists, and an open that trusted the store alone would
// land on a scratch tab in a folder that refuses writes. It joins
// state.workspaces like any workspace — panes, tabs, search, quick-open all
// just work — and the strip simply declines to show it (Sidebar filters kind
// "docs").
//
// The already-open branch must still land on a page: a docs workspace can be
// sitting on nothing but a reseeded scratch tab (its pages all closed, so
// closeTab's reseed rule ran in a folder where an unsaved note can never
// save), and since the strip never shows the workspace, "selected, showing
// nothing" is indistinguishable from a dead button — the click has to make
// the landing page appear, not merely select.
export async function openDocs(state: AppState, dispatch: (action: Action) => void): Promise<void> {
  const folder = docsFolder();
  if (!folder) return; // Bun never reported one; the command's `when` hides this path
  const existing = state.workspaces.find((w) => w.folder === folder);
  if (existing && tabPaths(existing.root).length > 0) {
    dispatch({ type: "selectWorkspace", id: existing.id });
    return;
  }
  let notes = notesOf(state, folder);
  let fetched = false;
  if (notes.length === 0) {
    // A failed list costs the landing page, not the open: the workspace still
    // appears (empty), and the focus refresh re-lists like any folder's.
    notes = await listNotes(folder).catch(() => []);
    fetched = true;
  }
  const start =
    notes.find((n) => n.title.toLowerCase() === "getting started") ??
    [...notes].sort((a, b) => a.path.localeCompare(b.path))[0];
  if (existing) {
    dispatch({ type: "selectWorkspace", id: existing.id });
    // openNote acts on the selected workspace at reduce time, so it follows
    // the select above and the page opens in the docs workspace's pane.
    if (start) dispatch({ type: "openNote", note: start });
  } else {
    dispatch({ type: "addWorkspace", name: "Documentation", folder, note: start });
  }
  // The browser (and quick-open) need the page list now, not at the next
  // focus refresh; the reducer seeded the folder empty.
  if (fetched) dispatch({ type: "notesLoaded", folder, notes });
}

// Close Workspace, the folder half: the reducer closes the view (refusing the
// last workspace), and only if the workspace actually went does the folder
// leave the registry. Detach never touches files — the folder is re-attachable
// with everything still in it — so no confirmation gates this (the hint on the
// command says so; interactions.md §4).
export function closeWorkspace(
  id: string,
  state: AppState,
  dispatch: (action: Action) => void,
): void {
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws || state.workspaces.length <= 1) return; // the reducer would refuse too
  dispatch({ type: "closeWorkspace", id });
  // The docs folder never detaches: its registry line is Bun's own (detachRoot
  // would refuse anyway), and closing the Documentation workspace is purely a
  // view arrangement — the docs icon reopens it.
  if (workspaceKind(ws.folder) === "docs") return;
  detachWorkspaceFolder(ws.folder).catch((err) => {
    // The workspace is gone from the view either way; a failed detach costs a
    // stale registry line that the next attach of the same folder reuses.
    console.error("[workspace] detach failed", err);
  });
}

// Move Workspace Folder… (and its Home face, `home: true`): flush pending
// saves first — they must land while the folder is still where their paths
// say (⌘L's flush-then-act ordering) — then Bun runs the destination picker
// (or targets the app home directly) and the rename, and the reducer swaps
// the workspace onto the new root. Open tabs close with the swap: their paths
// named the old location, and arrangement loss needs no confirm
// (interactions.md §4) — every note travels with the folder.
export async function moveWorkspace(
  id: string,
  state: AppState,
  dispatch: (action: Action) => void,
  home = false,
): Promise<string | null> {
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) return null;
  await flushAllNow();
  let res: Awaited<ReturnType<typeof moveWorkspaceFolder>>;
  try {
    res = await moveWorkspaceFolder(ws.folder, home);
  } catch (err) {
    console.error("[workspace] move failed", err);
    return err instanceof Error ? err.message : String(err);
  }
  if (res.error !== null) return res.error;
  // Cancelled, or the pick was the folder's own parent (Bun's no-op answer):
  // nothing moved, so nothing closes.
  if (res.root === null || res.root === ws.folder) return null;
  dispatch({ type: "workspaceFolderMoved", id, folder: res.root });
  await refreshFolder(res.root, dispatch);
  return null;
}

// Re-fetch one folder's notes and trash, each failure costing itself only.
export async function refreshFolder(
  folder: string,
  dispatch: (action: Action) => void,
): Promise<void> {
  await Promise.all([
    listNotes(folder)
      .then((notes) => dispatch({ type: "notesLoaded", folder, notes }))
      .catch((err) => console.error("[notes] refresh failed", folder, err)),
    listTrash(folder)
      .then((items) => dispatch({ type: "trashLoaded", folder, items }))
      .catch((err) => console.error("[notes] trash refresh failed", folder, err)),
  ]);
}
