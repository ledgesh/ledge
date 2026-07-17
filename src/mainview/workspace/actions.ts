// The workspace operations that need a Bun round trip before the reducer can
// act, mirroring notes/actions.ts: the reducer stays pure, so creating a
// folder, opening the attach dialog, and detaching a closed workspace's folder
// all orchestrate here.
import { listNotes, listTrash } from "../notes/channel";
import {
  attachWorkspaceFolder as attachFolder,
  createWorkspaceFolder,
  detachWorkspaceFolder,
} from "./channel";
import type { Action, AppState } from "./store";

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
  detachWorkspaceFolder(ws.folder).catch((err) => {
    // The workspace is gone from the view either way; a failed detach costs a
    // stale registry line that the next attach of the same folder reuses.
    console.error("[workspace] detach failed", err);
  });
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
