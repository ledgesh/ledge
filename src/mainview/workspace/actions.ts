// The workspace operations that need a Bun round trip before the reducer can
// act, mirroring notes/actions.ts. The reducer stays pure, so creating a
// folder, opening the attach dialog, and detaching a closed workspace's
// folder all orchestrate here.
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
import { docsLanding, notesOf, type Action, type AppState } from "./store";
import { tabPaths } from "./tree";

// New Workspace. Bun creates the folder first (it slugs the display name and
// allocates a name nothing else holds, bun/workspaces.ts), then this adds the
// workspace over it. The name counts the existing workspaces the way the old
// pure action did, so the strip still reads Workspace 2, Workspace 3, and so
// on.
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

// Attach Folder as Workspace. The native picker runs Bun-side, and the view
// gets back a root handle, a refusal, or null for a cancel. An already
// attached folder selects its existing workspace (one workspace per folder,
// in the reducer). The new workspace takes the folder's last path segment,
// the name the user just picked it by, and its lists load now, not at the
// next refresh.
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

// The workspace the manual was opened from, so the same button can put it
// away (closeDocs below). A module-level `let`, like the view's other small
// singletons: it is one id that belongs to no note and no workspace, and the
// store would put a fact about a header button into the state that gets
// persisted and reduced.
let cameFrom: string | null = null;

// Open the built-in Documentation workspace in this window. A client that has
// one window and can only have one takes this path (a phone; ios.md §11), and
// a shell with windows gives the manual a window of its own. The two paths
// meet nowhere but the command that chooses between them (commands/registry.ts
// docs.toggle, on lib/shell.ts multiWindow).
//
// Selects the docs workspace if it is already open, otherwise adds it over the
// docs folder Bun reported at boot. The manual opens on the Getting Started
// page, or on the first page in path order: the manifest's numbered filenames
// (bun/docsContent.ts), which is the order the browser lists a read-only
// workspace in (NoteBrowser.tsx).
//
// `page` names a page to land on by title, for the menu items that mean one
// page rather than the manual (Help > Third-Party Licenses). Passing it also
// gives up the shortcut below: reopening the manual keeps the page it was
// showing, while asking for the licenses has to open that page.
export async function openDocs(
  state: AppState,
  dispatch: (action: Action) => void,
  page?: string,
): Promise<void> {
  const folder = docsFolder();
  if (!folder) return; // Bun never reported one; the command's `when` hides this path
  const existing = state.workspaces.find((w) => w.folder === folder);
  // Record the way back before anything is selected, and only when coming
  // from another workspace. Opening the manual twice in a row must not
  // overwrite the way back with the manual itself.
  if (!existing || state.selectedId !== existing.id) cameFrom = state.selectedId;
  // The shortcut: an already-open manual with a page in it is selected and
  // nothing more. Every page closed leaves tabPaths empty, and the rest of the
  // function lands on a page instead. The strip does not show this workspace,
  // so selecting it and showing an empty pane would look like a dead button.
  if (!page && existing && tabPaths(existing.root).length > 0) {
    dispatch({ type: "selectWorkspace", id: existing.id });
    return;
  }
  let notes = notesOf(state, folder);
  let fetched = false;
  if (notes.length === 0) {
    // The page list comes from the store when a restored session already
    // carries it. A fresh-start boot seeds only the first workspace's lists,
    // so an empty list here means one round trip: trusting the store alone
    // would land on a scratch tab in a folder that refuses writes. A failed
    // list costs the landing page, not the open. The workspace still appears,
    // empty, and the focus refresh re-lists it like any folder (App.tsx).
    notes = await listNotes(folder).catch(() => []);
    fetched = true;
  }
  const start = docsLanding(notes, page);
  if (existing) {
    dispatch({ type: "selectWorkspace", id: existing.id });
    // openNote acts on the selected workspace at reduce time, so it follows
    // the select above and the page opens in the docs workspace's pane.
    if (start) dispatch({ type: "openNote", note: start });
  } else {
    // The docs workspace joins state.workspaces like any other, so panes,
    // tabs, search and quick-open all work on it. The strip does not list it
    // (Sidebar.tsx filters kind "docs").
    dispatch({ type: "addWorkspace", name: "Documentation", folder, note: start });
  }
  // The browser and quick-open need the page list now rather than at the next
  // focus refresh: the reducer seeded the folder empty.
  if (fetched) dispatch({ type: "notesLoaded", folder, notes });
}

/**
 * Put the manual away: select the workspace it was opened from.
 *
 * The other half of docs.toggle. The docs workspace is not a strip row and
 * not a ⌘1…9 slot, so the usual way back is to pick another workspace out of
 * the strip: a glance on a Mac, and on a phone a drawer the manual is
 * covering (ios.md §9). Pressing the lit docs button again runs this instead.
 *
 * Nothing is closed. The docs workspace stays in `state.workspaces` with its
 * tabs where they were, so coming back is cheap, the same as every other
 * workspace switch.
 */
export function closeDocs(state: AppState, dispatch: (action: Action) => void): void {
  const folder = docsFolder();
  // The remembered id is checked against the live list rather than trusted:
  // the workspace it names can have been closed while the manual was up.
  const back =
    state.workspaces.find((w) => w.id === cameFrom && w.folder !== folder) ??
    // Fall back to any workspace that is not the manual. One always exists:
    // the reducer refuses to close the last workspace, and the docs workspace
    // is never the first (openDocs adds it, over a folder Bun reported).
    state.workspaces.find((w) => w.folder !== folder);
  if (!back) return;
  cameFrom = null;
  dispatch({ type: "selectWorkspace", id: back.id });
}

// Close Workspace, the folder half. The reducer closes the view (refusing the
// last workspace), and the folder leaves the registry only if the workspace
// actually went. Detach never touches files: the folder is re-attachable with
// everything still in it, so nothing asks the user to confirm
// (interactions.md §4; commands/registry.ts workspace.close says the same).
export function closeWorkspace(
  id: string,
  state: AppState,
  dispatch: (action: Action) => void,
): void {
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws || state.workspaces.length <= 1) return; // the reducer would refuse too
  dispatch({ type: "closeWorkspace", id });
  // The docs folder never detaches. Its registry line is Bun's own, and
  // detachRoot refuses it anyway (bun/workspaces.ts). Closing the
  // Documentation workspace is a view arrangement: the docs icon reopens it.
  if (workspaceKind(ws.folder) === "docs") return;
  detachWorkspaceFolder(ws.folder).catch((err) => {
    // The workspace is gone from the view either way. A failed detach costs a
    // stale registry line, which the next attach of the same folder reuses.
    console.error("[workspace] detach failed", err);
  });
}

// Move Workspace Folder… and its Home face (`home: true`). This flushes
// pending saves first, so they land while the folder is still where their
// paths say (⌘L's flush-then-act ordering). Bun then runs the destination
// picker (or targets the app home directly) and the rename, and the reducer
// swaps the workspace onto the new root.
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
  // Open tabs close with the swap: their paths named the old location. Every
  // note travels with the folder, so this loses an arrangement and asks for no
  // confirmation (interactions.md §4).
  dispatch({ type: "workspaceFolderMoved", id, folder: res.root });
  await refreshFolder(res.root, dispatch);
  return null;
}

// Re-fetch one folder's notes and trash. Each list dispatches on its own, so
// one of them failing still leaves the other loaded.
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
