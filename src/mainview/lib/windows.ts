// The windows, as a seam (architecture.md §5): main.tsx binds these to the
// windowNew and windowDocs RPCs, the harness binds stubs, and the command
// registry reaches them through openWindow and openDocsWindow without
// importing either.
//
// A window is a client, not a second view of one (remote.md §8a): the shell
// opens it on the local server the way a launch does, and everything about
// which machine it ends up on is the ordinary Notes On… from inside it. So
// there is nothing to pass and nothing to hear back — whether the verb should
// have been offered at all is lib/shell.ts's multiWindow, asked before the
// call rather than learned from it.
//
// The manual's window is the one that carries an argument: which page it should
// land on, since Help > Third-Party Licenses means one page rather than the
// manual. It is still the same fire-and-forget — the shell either opens that
// window or raises the one that already exists, and neither answer is
// something this end could act on.
export interface WindowHandlers {
  open(): void;
  openDocs(page: string): void;
}

let handlers: WindowHandlers | null = null;

export function configureWindows(h: WindowHandlers): void {
  handlers = h;
}

export function openWindow(): void {
  handlers?.open();
}

/** Show the manual, in the window that holds it. `page` is a page title, or ""
 * for the landing page. */
export function openDocsWindow(page = ""): void {
  handlers?.openDocs(page);
}

// --- which window this is ----------------------------------------------------
//
// Every window runs this same view, and one of them is the manual's (the shell
// answers `windowRole` at boot). What follows from it is small and entirely
// about chrome: the window holds the manual and nothing else, so the surfaces
// that switch between workspaces or between machines have nothing to say in it
// (the sidebar's strip and connection bar, New Workspace, Notes On…, and the
// help button, which is what opened this window in the first place).
//
// A boot-static answer like the settings snapshot, recorded before the first
// render and never written again.
let docs = false;

export function recordWindowRole(role: { docs: boolean }): void {
  docs = role.docs;
}

/** Whether this window is the manual's. */
export function docsWindow(): boolean {
  return docs;
}

// --- landing on a page, after the window is up -------------------------------
//
// The shell pushes this when somebody asks for the manual while its window is
// already open (rpc `docsShow`): the window is raised by the shell, and the
// page asked for is this end's half. Only ever received in the manual's window.
//
// The same subscriber shape as an external open (notes/channel.ts), and for the
// same reason — App holds the note list and the panes, so App is the only thing
// that can turn a title into an open tab.

const showSubs = new Set<(page: string) => void>();

export function onDocsShow(fn: (page: string) => void): () => void {
  showSubs.add(fn);
  return () => showSubs.delete(fn);
}

export function dispatchDocsShow(page: string): void {
  for (const fn of showSubs) fn(page);
}
