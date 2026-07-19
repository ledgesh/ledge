// The keep-alive editor pool.
//
// In the Swift build, Bonsplit ran with `contentViewLifecycle: .keepAllAlive`
// because the editor is expensive to rebuild: throwing it away on a tab switch
// would lose the caret, scroll, undo stack, and inline run output. React's normal
// mount/unmount would do exactly that. So editors live here, keyed by a stable
// `docId`, outside the React tree: switching tabs only re-parents a view's DOM
// host into the newly-visible pane; it never destroys the view. A view is torn
// down only when its tab is closed (releaseEditor).
import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditor } from "../editor/setup";
import { handleRunEvent, pingOverlay } from "../editor/blocks";
import { onRunEvent } from "../editor/bridge";
import { fromDisk } from "../editor/session";
import { readNote } from "../notes/channel";
import {
  bindDoc,
  docIdAt,
  pathOf,
  releaseDoc,
  reloadCandidates,
  reseedDoc,
  seedSlug,
  type DocHandlers,
} from "../notes/store";
import { onVaultChanged, vaultState } from "../vault/channel";
import { evictAssetCache } from "../lib/assets";
import { changedSpan } from "../lib/textDiff";
import { revealHeading, revealSelection } from "./reveal";
import type { RunEvent } from "../../shared/rpc-schema";
import type { TabState } from "./tree";

// Seed content for a note with no file yet. The very first tab shows the demo
// note (the whole run loop on first launch); every other new tab opens as a
// near-empty scratch note. A tab whose note is already on disk ignores these and
// loads the file instead. Built from lines so the ``` fences don't collide with
// JS backticks.
const DEMO_DOC = [
  "# Ledge",
  "",
  "Runnable Markdown notes. Drop a shell block below, then press Cmd+Enter inside it, or click the run button that appears when you hover the block.",
  "",
  "```sh",
  'echo "hello from Ledge on Electrobun"',
  'echo "arch: $(uname -m)"',
  "uname -sr",
  "```",
  "",
  "Output streams into a panel beneath the block. The shell is reused across runs, so cwd and environment changes persist from one block to the next.",
  "",
  "```sh",
  "pwd",
  "date",
  "```",
  "",
].join("\n");

// Just the H1 — the rename UI and the note's identity, nothing else. A new
// note is the user's blank page: no sample block to delete first.
const SCRATCH_DOC = ["# Untitled", "", ""].join("\n");

function seedDoc(seed: "demo" | "scratch"): string {
  return seed === "demo" ? DEMO_DOC : SCRATCH_DOC;
}

// Translate a Bun-side RunEvent into the (kind, payload) shape handleRunEvent
// understands (its vocabulary predates the RPC).
function applyRunEvent(view: EditorView, ev: RunEvent): void {
  if (ev.kind === "began") handleRunEvent(view, ev.id, "started", null);
  else if (ev.kind === "output") handleRunEvent(view, ev.id, "output", ev.dataB64);
  else handleRunEvent(view, ev.id, "finished", ev.exitCode);
}

interface Entry {
  host: HTMLDivElement;
  view: EditorView;
  offRun: () => void;
  ro: ResizeObserver;
  // The note is LOCKED (docs/locking.md): true from the moment a read says
  // so, whether or not the body was withheld. What the vault relock must
  // evict is exactly the entries wearing this.
  lockedNote: boolean;
  // The held placeholder face, present while the body is withheld (vault
  // locked). The CM view sits empty and hidden beneath it — never holding
  // ciphertext, never holding plaintext.
  heldFace: HTMLDivElement | null;
}

const pool = new Map<string, Entry>();

// --- the locked placeholder face --------------------------------------------
// Plain DOM like the rest of the pool (the pool lives outside React); the
// Unlock button reaches the command layer through a configureX seam — the
// pool cannot import the registry without a cycle, and the button must run
// the SAME vault.unlock the palette runs.

let lockedUi: { requestUnlock?: () => void } = {};

export function configureLockedUi(fns: { requestUnlock?: () => void }): void {
  Object.assign(lockedUi, fns);
}

function showHeldFace(entry: Entry, damaged: boolean): void {
  entry.view.dom.style.display = "none";
  if (entry.heldFace) entry.heldFace.remove();
  // An absolute OVERLAY inside the host, never a sibling in flow: the host
  // already fills the pane, and a stacked face would grow the page past the
  // viewport — turning the app's fixed layout scrollable, which (beyond
  // looking broken) reroutes wheel events away from every horizontal
  // scroller (the tab strip lost its sideways wheel to exactly this).
  entry.host.style.position = "relative";
  const face = document.createElement("div");
  face.className =
    "ledge-locked-face absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-8 text-center";
  face.dataset.testid = "locked-face";
  const glyph = document.createElement("div");
  glyph.className = "text-muted-foreground";
  glyph.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  const msg = document.createElement("p");
  msg.className = "max-w-sm text-[13px] leading-snug text-muted-foreground";
  msg.textContent = damaged
    ? "This locked note's body is damaged: the file was modified outside Ledge. Restore it from a backup or your sync service's history."
    : "This note is locked. Its body stays sealed on disk, away from agents and search, until you unlock.";
  face.append(glyph, msg);
  if (!damaged) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.testid = "locked-face-unlock";
    btn.className =
      "rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm hover:bg-accent hover:text-accent-foreground";
    btn.textContent = "Unlock Notes…";
    btn.addEventListener("click", () => lockedUi.requestUnlock?.());
    face.append(btn);
  }
  entry.host.appendChild(face);
  entry.heldFace = face;
}

function clearHeldFace(entry: Entry): void {
  entry.heldFace?.remove();
  entry.heldFace = null;
  entry.view.dom.style.display = "";
}

// --- reveals ----------------------------------------------------------------
//
// "Open this note AND show me a place in it" — the matched line from the
// search overlay, or the `#heading` anchor of a followed wikilink.
// Keyed by path, not docId: the hit's path is the only handle the overlay
// holds — the docId does not exist until the tab opens. One-shot: a request is
// consumed by the first editor that can honor it, so a stale one can never
// yank the selection around on some later tab switch.
type RevealRequest = { line: number; query: string } | { heading: string };

const pendingReveals = new Map<string, RevealRequest>();

export function requestReveal(path: string, line: number, query: string): void {
  queueReveal(path, { line, query });
}

/** A wikilink's `#heading` anchor: reveal that heading when `path` opens. */
export function requestHeadingReveal(path: string, heading: string): void {
  queueReveal(path, { heading });
}

function queueReveal(path: string, req: RevealRequest): void {
  // A note already open with its text on screen gets the reveal immediately:
  // its tab may already be the active one, in which case no attach — the
  // other consumer below — will ever revisit it. A detached (background-tab)
  // editor waits for its attach instead: CodeMirror measures scroll targets
  // against live geometry, which a detached host does not have.
  const docId = docIdAt(path);
  const entry = docId ? pool.get(docId) : undefined;
  if (entry && entry.host.isConnected) {
    applyReveal(entry.view, req);
    return;
  }
  pendingReveals.set(path, req);
}

function takeReveal(path: string, view: EditorView): void {
  const req = pendingReveals.get(path);
  if (!req) return;
  pendingReveals.delete(path);
  applyReveal(view, req);
}

function applyReveal(view: EditorView, req: RevealRequest): void {
  const sel =
    "heading" in req
      ? revealHeading(view.state.doc, req.heading)
      : revealSelection(view.state.doc, req.line, req.query);
  view.dispatch({
    selection: { anchor: sel.anchor, head: sel.head },
    effects: EditorView.scrollIntoView(sel.anchor, { y: "center" }),
  });
  // A reveal is "take me there": the caret belongs on the match. Focus is also
  // what makes the selection visible — and when the hit's note was already the
  // active tab, nothing else (PaneTree's focus effect keys on the docId, which
  // did not change) would put it in the editor.
  view.focus();
}

// Pour a note's saved text into its (empty, freshly-created) editor. The read is
// async, so the editor exists first and the content arrives a beat later; the
// alternative, holding the pane blank until the file lands, would make every tab
// switch to an unopened note flicker.
//
// `fromDisk` keeps the change listener from treating the load as an edit and
// saving it straight back, and it stays out of the undo history so the first
// Cmd+Z in a note cannot wipe it back to empty.
async function loadNote(docId: string, path: string): Promise<void> {
  const file = await readNote(path);
  if (file === null) return; // note is gone; leave the editor empty rather than guess
  // Before the text reaches the editor, tell the save controller which heading this
  // note ALREADY has. Filenames follow the H1 from here on, and without this the
  // load itself would look like the heading appearing from nowhere and move the
  // file. A note only gets renamed by a heading you edit, never by one you open.
  // The mtime rides along: it is the disk version every later save states as
  // its expectation (the external-edit guard).
  // Held notes seed too — from the plaintext head, which carries the same H1
  // the full text would — so an unlock's re-load is an ordinary reload, not
  // a first sight that could look like a rename.
  seedSlug(docId, file.text, file.mtimeMs);
  const entry = pool.get(docId);
  if (!entry) return; // the tab closed while the read was in flight
  entry.lockedNote = !!file.locked;
  if (file.held) {
    // The body was withheld (vault locked, or damage): the tab is a
    // placeholder, not an editor — nothing pours, nothing reveals
    // (docs/locking.md §4). The pending reveal, if any, stays queued for the
    // unlock's re-load.
    showHeldFace(entry, !!file.damaged);
    return;
  }
  clearHeldFace(entry);
  entry.view.dispatch({
    changes: { from: 0, to: entry.view.state.doc.length, insert: file.text },
    annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
  });
  // Only now is there text for a search reveal to land on.
  takeReveal(path, entry.view);
}

// Re-read every open, UNEDITED note and pour in any text that changed on disk
// (an agent in the note's own terminal, git, a shell edit). Called on the
// watcher's notesChanged push and on window focus (the belt). The decisions —
// who is a candidate, whether the adoption still holds after the async read —
// live in the store (reloadCandidates / reseedDoc); this wrapper only touches
// CodeMirror. Same annotations as loadNote: a reload is not an edit (nothing
// to save back) and not undoable (Cmd+Z must not resurrect text the file no
// longer holds — the buffer was clean, so nothing of the user's is at stake).
// A note whose file is GONE is left showing what it had: deleting is the
// delete flow's job (and the note list refresh already dropped the row); a
// next edit here recreates the file, which is the kinder failure.
export async function reloadOpenNotes(): Promise<void> {
  for (const cand of reloadCandidates()) {
    const file = await readNote(cand.path);
    if (file === null || file.mtimeMs === cand.mtimeMs) continue;
    const entry = pool.get(cand.docId);
    if (!entry) continue; // tab closed while the read was in flight
    // Lock-state transitions arrive through this same path (Lock This Note /
    // Remove Lock refresh the folder; an external sync can flip a marker
    // too). The flag must track the disk so a later relock knows what to
    // evict — and a note that became HELD under us (locked elsewhere while
    // our vault is locked) swaps to the placeholder instead of pouring its
    // withheld head into an editor.
    entry.lockedNote = !!file.locked;
    if (file.held) {
      if (!entry.heldFace && reseedDoc(cand.docId, cand.path, file.text, file.mtimeMs)) {
        evictToHeldFace(cand.docId, entry, !!file.damaged);
      }
      continue;
    }
    if (entry.heldFace) {
      // Unlocked content for a tab still wearing the face (an unlock's
      // re-load raced this reload): the ordinary load path owns that swap.
      void loadNote(cand.docId, cand.path);
      continue;
    }
    if (!reseedDoc(cand.docId, cand.path, file.text, file.mtimeMs)) continue; // dirtied meanwhile
    const view = entry.view;
    // Dispatch the SMALLEST span that changed, never a full-document replace:
    // a full replace maps every anchored position to the document's edges —
    // run-output panels (blocks.ts runsField) teleport below appended text,
    // and the caret ends up clamped instead of mapped. With a minimal span,
    // positions outside it (usually including the caret — the buffer was
    // clean, the user was elsewhere) do not move at all; CodeMirror maps the
    // selection through the change on its own.
    const span = changedSpan(view.state.doc.toString(), file.text);
    if (!span) continue; // same bytes, newer mtime: reseed above already recorded it
    view.dispatch({
      changes: span,
      annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
    });
  }
}

// Get (creating on first use) the pooled editor for a tab's note. The returned
// host is a detached <div> until attachEditor parents it into a pane. `folder`
// is the tab's workspace folder, recorded so a first save creates the file
// there and asset references resolve against it (notes/store.ts).
function acquire(tab: TabState, folder: string, handlers: DocHandlers): { entry: Entry; created: boolean } {
  const { docId } = tab;
  // Rebind on every acquire: the entry may predate this callback's closure, and
  // an already-open note keeps whatever dirty state, path, and seeded slug it has.
  bindDoc(docId, tab.path, folder, handlers);
  const existing = pool.get(docId);
  if (existing) return { entry: existing, created: false };

  const host = document.createElement("div");
  host.className = "ledge-editor-host";
  const view = createEditor(host, tab.path ? "" : seedDoc(tab.seed), docId);
  const offRun = onRunEvent((ev) => applyRunEvent(view, ev));
  // CodeMirror does not watch its container for size changes; a pane resize (a
  // divider drag, the terminal drawer opening) needs an explicit re-measure.
  const ro = new ResizeObserver(() => view.requestMeasure());
  ro.observe(host);

  const entry: Entry = { host, view, offRun, ro, lockedNote: false, heldFace: null };
  pool.set(docId, entry);
  if (tab.path) void loadNote(docId, tab.path);
  return { entry, created: true };
}

// --- vault transitions -------------------------------------------------------
// One subscription for the whole pool (module-level, like the pool itself):
// on RELOCK every locked entry is evicted — the view is DESTROYED and rebuilt
// empty, because a doc replace would leave the plaintext in the undo history,
// and an eviction that Cmd+Z can reverse is theater — then shown the held
// face. On UNLOCK every held entry re-loads through the ordinary loadNote,
// which pours the decrypted text and clears the face. Dirty-buffer safety is
// upstream: ⌘L flushes before Bun drops keys (glue), and the idle relock
// proves cleanliness by 15 minutes of silence.
// Evict one entry's decrypted state and show the held face. The view is
// DESTROYED and rebuilt empty, because a doc replace would leave the
// plaintext in the undo history, and an eviction that Cmd+Z can reverse is
// theater; run panels die with the view for the same reason. The host (and
// its ResizeObserver) survive.
function evictToHeldFace(docId: string, entry: Entry, damaged: boolean): void {
  entry.offRun();
  entry.view.destroy();
  const view = createEditor(entry.host, "", docId);
  entry.view = view;
  entry.offRun = onRunEvent((ev) => applyRunEvent(view, ev));
  showHeldFace(entry, damaged);
}

onVaultChanged(() => {
  if (vaultState() === "unlocked") {
    for (const [docId, entry] of pool) {
      if (!entry.heldFace) continue;
      const path = pathOf(docId);
      if (path) void loadNote(docId, path);
    }
    return;
  }
  let evicted = false;
  for (const [docId, entry] of pool) {
    if (!entry.lockedNote || entry.heldFace) continue;
    evicted = true;
    evictToHeldFace(docId, entry, false);
  }
  // The image cache holds decrypted data URLs by the same promise (RAM the
  // lock must clear); the flag keeps a no-locked-notes relock from churning
  // innocent bystanders' cached images.
  if (evicted) evictAssetCache();
});

// Parent the editor's host into `container` and re-pin its overlay. Returns the
// live EditorView so the caller can focus it. `handlers` carries the two ways a
// note's name can move: its file appearing or being renamed to follow its H1
// (onFile), and its on-screen label changing (onTitle).
export function attachEditor(
  container: HTMLElement,
  tab: TabState,
  folder: string,
  handlers: DocHandlers,
): EditorView {
  const { entry, created } = acquire(tab, folder, handlers);
  if (entry.host.parentElement !== container) container.appendChild(entry.host);
  entry.view.requestMeasure();
  pingOverlay(entry.view);
  // A reveal aimed at a background tab lands on its attach. Only a pre-existing
  // editor: a freshly created one is still empty (its text arrives async in
  // loadNote, which consumes the request once there are lines to reveal).
  if (!created && tab.path) takeReveal(tab.path, entry.view);
  return entry.view;
}

// Detach the editor's host (tab deactivated) without destroying the view, then
// collapse its now-orphaned overlay.
export function detachEditor(docId: string): void {
  const entry = pool.get(docId);
  if (!entry) return;
  entry.host.remove();
  pingOverlay(entry.view);
}

// Tear an editor down for good. Called when a tab is closed. releaseDoc first:
// the view is about to go, and any edit still sitting in the autosave debounce
// has to reach disk rather than die with it.
export function releaseEditor(docId: string): void {
  releaseDoc(docId);
  const entry = pool.get(docId);
  if (!entry) return;
  entry.offRun();
  entry.ro.disconnect();
  entry.view.destroy();
  entry.host.remove();
  pool.delete(docId);
}

export function focusEditor(docId: string): void {
  pool.get(docId)?.view.focus();
}

// Read-only access to a pooled view, for commands invoked from outside the
// editor (the palette's Find/Run entries refocus and then drive the view).
export function getEditorView(docId: string): EditorView | null {
  return pool.get(docId)?.view ?? null;
}

// Every pooled view, attached or not. App broadcasts wikilink refreshes over
// this when the note lists change (livePreview.refreshWikilinks): a detached
// background editor takes the redraw too, so it comes back correct.
export function allEditorViews(): EditorView[] {
  return [...pool.values()].map((e) => e.view);
}
