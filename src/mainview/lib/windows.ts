// The windows, as a configureX seam (architecture.md §5). boot.tsx binds these
// to the `windowNew` and `windowDocs` RPCs and harness.tsx binds stubs, so the
// command registry never imports either. A window is a client rather than a
// second view of one (remote.md §8a): open() has nothing to pass, and neither
// call hears an answer back. lib/shell.ts's multiWindow gates New Window.
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

/** Show the manual in the window that holds it. `page` is a page title, for the
 * menu items that open a single page (Help > Third-Party Licenses), or "" for
 * the landing page. The shell opens that window or raises the one already
 * showing the manual, and this end never learns which. A client with one window
 * opens the manual in that window instead (lib/shell.ts multiWindow). */
export function openDocsWindow(page = ""): void {
  handlers?.openDocs(page);
}

// --- which window this is ----------------------------------------------------
//
// Every window runs this same view, and one of them is the manual's (the shell
// answers `windowRole` at boot). That window holds the manual and nothing else.
// It leaves out the surfaces that switch between workspaces or between
// machines: the sidebar's strip and connection bar, New Workspace, Notes On…,
// and the help button that opened this window.

// `docs` is boot-static, like the settings snapshot: recorded before the first
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
// already open (rpc `docsShow`). The shell raises the window. This end opens
// the page the push names. Only ever received in the manual's window.
//
// The same subscriber shape as an external open (notes/channel.ts), for the
// same reason: App holds the note list and the panes, so App is the only thing
// that can turn a title into an open tab.

const showSubs = new Set<(page: string) => void>();

export function onDocsShow(fn: (page: string) => void): () => void {
  showSubs.add(fn);
  return () => showSubs.delete(fn);
}

export function dispatchDocsShow(page: string): void {
  for (const fn of showSubs) fn(page);
}
