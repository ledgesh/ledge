// The keep-alive editor pool. Editors live here, keyed by a stable `docId` and
// outside the React tree. Switching tabs re-parents a view's DOM host into the
// newly visible pane and never destroys the view; only closing a tab tears one
// down (releaseEditor). An editor is expensive to rebuild, and React's normal
// mount/unmount would rebuild it on every switch, losing the caret, scroll,
// undo stack, and inline run output. The Swift build kept editors alive for the
// same reason, through Bonsplit's `contentViewLifecycle: .keepAllAlive`.
import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditor } from "../editor/setup";
import { handleRunEvent, pingOverlay, runningRunIds, setRunsLink } from "../editor/blocks";
import { onRunEvent, type RunSink } from "../editor/bridge";
import { fromDisk } from "../editor/session";
import { readNote, stashNote } from "../notes/channel";
import {
  adoptOverStranded,
  bindDoc,
  docIdAt,
  pathOf,
  releaseDoc,
  reloadCandidates,
  releaseSaves,
  reseedDoc,
  savesHeld,
  savesSettled,
  seedSlug,
  strandedCandidates,
  type DocHandlers,
} from "../notes/store";
import { onVaultChanged, vaultState } from "../vault/channel";
import { workspaceKind } from "./channel";
import { evictAssetCache } from "../lib/assets";
import { changedSpan } from "../lib/textDiff";
import { revealHeading, revealSelection, revealTitle } from "./reveal";
import type { RunEvent } from "../../shared/rpc-schema";
import type { TabState } from "./tree";
import { seedDoc } from "./seeds";

// Translate a Bun-side RunEvent into the (kind, payload) shape handleRunEvent
// understands (its vocabulary predates the RPC).
function applyRunEvent(view: EditorView, ev: RunEvent): void {
  if (ev.kind === "began") handleRunEvent(view, ev.id, "started", null);
  else if (ev.kind === "output") handleRunEvent(view, ev.id, "output", ev.dataB64);
  else handleRunEvent(view, ev.id, "finished", ev.exitCode);
}

// One editor's end of the run channel (bridge.ts RunSink): run events go in,
// and the runs the view still shows come out. The sink is registered and
// dropped with the view, so a view that was replaced no longer claims runs
// whose panels went with it.
function runSink(view: EditorView): RunSink {
  return {
    apply: (ev) => applyRunEvent(view, ev),
    live: () => runningRunIds(view.state),
    link: (up) => setRunsLink(view, up),
  };
}

interface Entry {
  host: HTMLDivElement;
  view: EditorView;
  offRun: () => void;
  ro: ResizeObserver;
  // Whether the note is locked (locking.md), set from what a read reports,
  // whether or not that read withheld the body. A vault relock evicts exactly
  // the entries with this set.
  lockedNote: boolean;
  // The placeholder face, present while the body is withheld (vault locked).
  // The CodeMirror view sits empty and hidden beneath it, holding neither
  // ciphertext nor plaintext.
  heldFace: HTMLDivElement | null;
}

const pool = new Map<string, Entry>();

// --- the locked placeholder face --------------------------------------------
// Plain DOM like the rest of the pool, which lives outside React. The Unlock
// button reaches the command layer through a configureX seam, because the pool
// cannot import the registry without a cycle and the button has to run the
// same `vault.unlock` the palette runs (App.tsx wires it).

let lockedUi: { requestUnlock?: () => void } = {};

export function configureLockedUi(fns: { requestUnlock?: () => void }): void {
  Object.assign(lockedUi, fns);
}

function showHeldFace(entry: Entry, damaged: boolean): void {
  entry.view.dom.style.display = "none";
  if (entry.heldFace) entry.heldFace.remove();
  // Position the face as an overlay inside the host, never as a sibling in
  // flow. The host already fills the pane, so a stacked face would grow the
  // page past the viewport and make the app's fixed layout scrollable. That
  // reroutes wheel events away from every horizontal scroller: the tab strip
  // lost its sideways wheel this way.
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
    // This face is built by hand, so the class list is all of its styling,
    // including the only touch sizing in this file (interactions.md §1a). The
    // button is the only way past a locked note on a client with no ⌘ key, and
    // on a phone it sits where the drawer's rows were a moment ago.
    btn.className =
      "rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm hover:bg-accent hover:text-accent-foreground touch:min-h-[44px] touch:px-4";
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
// A reveal is a request to put the selection somewhere in a note when it
// opens: the search overlay's matched line, or a wikilink's `#heading` anchor.
// These functions only park the request; something else opens the note. Keyed
// by path, because that is what the overlay holds and the docId does not exist
// until the tab opens. The first editor that can honor a request consumes it,
// so a stale one cannot move a later tab's selection.
type RevealRequest =
  | { line: number; query: string }
  | { heading: string }
  | { title: { placeholder: boolean } };

const pendingReveals = new Map<string, RevealRequest>();

export function requestReveal(path: string, line: number, query: string): void {
  queueReveal(path, { line, query });
}

/** A wikilink's `#heading` anchor: reveal that heading when `path` opens. */
export function requestHeadingReveal(path: string, heading: string): void {
  queueReveal(path, { heading });
}

/**
 * Put the caret inside a just-created note's title when it opens, so the first
 * keystroke names the note. `placeholder` selects the app's made-up "Untitled"
 * so typing replaces it; a title the app computed, like a daily note's date,
 * gets the caret alone. Queued like the other reveals because the text arrives
 * after the tab renders. Only creation calls this. Opening a note that already
 * exists leaves the caret where opening always put it.
 */
export function requestTitleCaret(path: string, placeholder: boolean): void {
  queueReveal(path, { title: { placeholder } });
}

function queueReveal(path: string, req: RevealRequest): void {
  // An editor whose host is already attached gets the reveal right away: its
  // tab may already be the active one, and then no attach (the other consumer,
  // in attachEditor below) would revisit it. A detached background-tab editor
  // waits for its attach instead, because CodeMirror measures scroll targets
  // against live geometry that a detached host does not have.
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
    "title" in req
      ? revealTitle(view.state.doc, req.title.placeholder)
      : "heading" in req
        ? revealHeading(view.state.doc, req.heading)
        : revealSelection(view.state.doc, req.line, req.query);
  view.dispatch({
    selection: { anchor: sel.anchor, head: sel.head },
    effects: EditorView.scrollIntoView(sel.anchor, { y: "center" }),
  });
  // A reveal puts the caret on the match, and focus is what makes the
  // selection visible. When the hit's note was already the active tab, nothing
  // else would put focus in the editor: PaneTree's focus effect keys on the
  // docId, which did not change.
  view.focus();
}

// Pour a note's saved text into its empty, freshly created editor. The read is
// async, so the editor exists first and the text arrives a beat later: holding
// the pane blank until the file lands would flicker on every tab switch to an
// unopened note. `fromDisk` stops the change listener from saving the load
// back as an edit; staying out of the undo history stops Cmd+Z emptying it.
async function loadNote(docId: string, path: string): Promise<void> {
  const file = await readNote(path);
  if (file === null) return; // note is gone; leave the editor empty rather than guess
  // Tell the save controller which heading this note already has, before the
  // text reaches the editor. Filenames follow the H1 from here on. Without
  // this, the load itself would look like a heading appearing from nowhere and
  // move the file. Only a heading edited here renames a note, never one that
  // was merely opened. The mtime rides along as the disk version every later
  // save states as its expectation (the external-edit guard). A held note
  // seeds from its plaintext head, which carries the same H1 the full text
  // would, so an unlock's re-load is an ordinary reload rather than a first
  // sight that could look like a rename.
  seedSlug(docId, file.text, file.mtimeMs);
  const entry = pool.get(docId);
  if (!entry) return; // the tab closed while the read was in flight
  entry.lockedNote = !!file.locked;
  if (file.held) {
    // The body was withheld (the vault is locked, or the envelope is
    // damaged): the tab shows a placeholder instead of an editor, so no text
    // pours and no reveal runs (locking.md §4). A pending reveal stays queued
    // for the unlock's re-load.
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

// Re-read every open, unedited note and pour in any text that changed on disk
// (an agent in the note's own terminal, git, a shell edit). Called on the
// watcher's notesChanged push, on a relink, and on window focus as the backstop
// for that push (App.tsx). reloadCandidates picks which notes qualify and
// reseedDoc decides whether the read still applies afterwards; this wrapper
// only touches CodeMirror. The annotations match loadNote: a reload is not an
// edit (nothing to save back), and it stays out of the undo history, so Cmd+Z
// cannot restore text the file no longer holds. The buffer was clean, so
// nothing of the user's is at stake. A note whose file is gone keeps showing
// what it had. Deleting is the delete flow's job, and the note list refresh has
// already dropped the row. A later edit here recreates the file.
export async function reloadOpenNotes(): Promise<void> {
  // Read every candidate at once, then apply. Serially this was one round trip
  // per open tab. In-process that is free. Against a server across a network it
  // is a third of a second of stalled focus (remote.md §12), on a path that
  // fires on every window focus and every watcher push, Ledge's own saves
  // included. The apply loop stays sequential because it touches CodeMirror,
  // and reseedDoc still refuses a doc that was dirtied while the read was out:
  // the same guard the serial version relied on, for the same reason.
  const candidates = reloadCandidates();
  const files = await Promise.all(candidates.map((c) => readNote(c.path)));
  for (const [i, cand] of candidates.entries()) {
    const file = files[i]!;
    if (file === null || file.mtimeMs === cand.mtimeMs) continue;
    const entry = pool.get(cand.docId);
    if (!entry) continue; // tab closed while the read was in flight
    // Lock-state transitions arrive through this same path: Lock This Note and
    // Remove Lock refresh the folder, and an external sync can flip a marker.
    // The flag tracks the disk so a later relock knows what to evict. A note
    // locked elsewhere while this vault is locked comes back held, and swaps
    // to the placeholder instead of pouring its withheld head into an editor.
    entry.lockedNote = !!file.locked;
    if (file.held) {
      if (!entry.heldFace && reseedDoc(cand.docId, cand.path, file.text, file.mtimeMs)) {
        evictToHeldFace(cand.docId, entry, !!file.damaged);
      }
      continue;
    }
    if (entry.heldFace) {
      // Unlocked content for a tab that still shows the held face (an
      // unlock's re-load raced this reload): loadNote owns that swap.
      void loadNote(cand.docId, cand.path);
      continue;
    }
    if (!reseedDoc(cand.docId, cand.path, file.text, file.mtimeMs)) continue; // dirtied meanwhile
    const view = entry.view;
    // Dispatch the smallest span that changed, never a full-document replace.
    // A full replace maps every anchored position to the document's edges:
    // run-output panels (blocks.ts runsField) land below appended text and the
    // caret is clamped rather than mapped. A minimal span leaves positions
    // outside it alone, and CodeMirror maps the selection through the change.
    const span = changedSpan(view.state.doc.toString(), file.text);
    if (!span) continue; // same bytes, newer mtime: reseed above already recorded it
    view.dispatch({
      changes: span,
      annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
    });
  }
}

/**
 * Settle every buffer that was typed while the server could not be reached,
 * then let saving resume. The server's version wins and the buffer is parked in
 * the trash, where restoring it puts the stashed copy beside the live note.
 * remote.md §7 owns that rule and why it reverses the ordinary divergence
 * handling.
 *
 * The mirror of reloadOpenNotes. That one pours the server's text into buffers
 * with nothing at stake; this one takes the dirty buffers it skips, where both
 * sides hold text. Called on a relink only, never on window focus and never on
 * a watcher push. On those two paths a dirty buffer means somebody is
 * mid-thought, and the next save's own guard arbitrates.
 *
 * Releases the hold whatever happened above it, so a reconciliation that threw
 * cannot leave the app unable to save.
 */
export async function resolveStrandedNotes(): Promise<void> {
  try {
    // Only after an outage that actually suspended saving. A wire that flapped
    // and came back never suspended anything: those writes waited on the
    // ladder and landed, so a buffer still dirty here is somebody mid-thought.
    // Taking it away is the clobber this path exists to prevent, and it would
    // happen every time a phone changed cell (remote.md §7).
    if (!savesHeld()) return;
    // Wait for the writes already out to finish failing before reading the
    // buffers. A save the wire killed puts its text back in the buffer on the
    // way out. A restarted server announces `lost` and `live` close enough
    // together that the dying save has not got that far yet (store.ts
    // savesSettled). Nothing new starts meanwhile, because the hold is on.
    await savesSettled();
    const stranded = strandedCandidates();
    if (stranded.length === 0) return;
    // Every read at once, the round-trip stance reloadOpenNotes takes
    // (remote.md §12). This runs the moment a wire comes back, a bad moment to
    // spend one trip per open tab.
    const files = await Promise.all(stranded.map((c) => readNote(c.path).catch(() => null)));
    for (const [i, cand] of stranded.entries()) {
      const file = files[i]!;
      // Gone, or never seen: nothing to arbitrate against. The buffer keeps
      // what it has and the ordinary save path recreates the file.
      if (file === null || cand.mtimeMs === null) continue;
      // The note did not move. The buffer is only unsaved, and releaseSaves
      // below flushes it.
      if (file.mtimeMs === cand.mtimeMs) continue;
      // Locked with the vault shut: the body on screen is withheld, and the
      // buffer cannot be sealed to park it. The idle relock's own eviction
      // handles this case (remote.md §7). It is the one path allowed to drop
      // the edit, because a locked note's save could not have landed either
      // way.
      if (file.held) continue;
      const entry = pool.get(cand.docId);
      if (!entry) continue; // tab closed while the read was out
      if (file.text === cand.text) {
        // Somebody else wrote the same text. Nothing is at stake and nothing
        // needs parking, so the buffer only has to stop being dirty.
        adoptOverStranded(cand.docId, cand.path, file.text, file.mtimeMs, cand.text, null);
        continue;
      }
      let stashedTo: string;
      try {
        stashedTo = await stashNote(cand.path, cand.text);
      } catch (err) {
        // Nowhere to park it (a relocked vault, a server too old to know the
        // method, a wire that dropped again). Keep the buffer: an unresolved
        // conflict can still be sorted out, a discarded paragraph cannot.
        console.error("[notes] could not park a stranded edit; keeping it in the buffer", cand.path, err);
        continue;
      }
      if (!adoptOverStranded(cand.docId, cand.path, file.text, file.mtimeMs, cand.text, stashedTo)) continue;
      const span = changedSpan(entry.view.state.doc.toString(), file.text);
      if (span) {
        entry.view.dispatch({
          changes: span,
          // Not undoable, for a stronger reason than reloadOpenNotes has.
          // There the buffer was clean; here a Cmd+Z would put the stranded
          // text back and mark the note dirty again, rebuilding the conflict
          // that was just settled. The copy in the trash is the way back, and
          // the notice says so (store.ts strandedNotice).
          annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
        });
      }
      console.warn("[notes] a stranded edit was parked in the trash:", stashedTo, "(the server's copy of", cand.path, "won)");
    }
  } finally {
    releaseSaves();
  }
}

// Get (creating on first use) the pooled editor for a tab's note. The returned
// host is a detached <div> until attachEditor parents it into a pane. `folder`
// is the tab's workspace folder, recorded so a first save creates the file
// there and asset references resolve against it (notes/store.ts).
function acquire(tab: TabState, folder: string, handlers: DocHandlers): { entry: Entry; created: boolean } {
  const { docId } = tab;
  // Rebind on every acquire: the entry may predate this callback's closure,
  // and an already-open note keeps the dirty state, path, and seeded slug it
  // has.
  bindDoc(docId, tab.path, folder, handlers);
  const existing = pool.get(docId);
  if (existing) return { entry: existing, created: false };

  const host = document.createElement("div");
  host.className = "ledge-editor-host";
  // A docs-workspace note gets the read-only editor (setup.ts): the folder
  // was captured at bind and tabs never change workspace, so the choice is
  // per-editor-lifetime, like every settings read.
  const view = createEditor(host, tab.path ? "" : seedDoc(tab.seed), docId, workspaceKind(folder) === "docs");
  // A new scratch note is seeded here rather than read from a file, so its
  // caret is placed here too, on the terms requestTitleCaret uses for a note
  // created on disk: on the title, with the placeholder word selected, so the
  // first keystroke names the note. The welcome note (the demo seed) is for
  // reading rather than naming, and keeps the caret at the top of the document.
  if (!tab.path && tab.seed === "scratch") {
    view.dispatch({ selection: revealTitle(view.state.doc, true) });
  }
  const offRun = onRunEvent(runSink(view));
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
// One subscription for the whole pool, module-level like the pool itself. A
// relock evicts every locked entry and shows the held face. An unlock re-loads
// every held entry through the ordinary loadNote, which pours the decrypted
// text and clears the face. Dirty buffers are handled upstream: ⌘L flushes
// before Bun drops the keys (glue), and the idle relock fires only after 15
// minutes without note traffic (locking.md §3).

// Evict one entry's decrypted state and show the held face. The view is
// destroyed and rebuilt empty rather than having its doc replaced, because a
// replace would leave the plaintext in the undo history for Cmd+Z to bring
// back; run panels go with the view for the same reason. The host and its
// ResizeObserver survive.
function evictToHeldFace(docId: string, entry: Entry, damaged: boolean): void {
  entry.offRun();
  entry.view.destroy();
  const view = createEditor(entry.host, "", docId);
  entry.view = view;
  entry.offRun = onRunEvent(runSink(view));
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
  // The image cache holds decrypted data URLs: RAM only, but RAM this lock has
  // to clear as well (locking.md §3). The flag keeps a relock that evicted
  // nothing from dropping cached images that no lock covers.
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
  // A reveal aimed at a background tab lands on its attach, and only for an
  // editor that already existed: a freshly created one is still empty, and
  // loadNote consumes the request once its text arrives.
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

// Tear an editor down for good, when a tab is closed. releaseDoc runs first so
// that an edit still sitting in the autosave debounce is written out rather
// than lost with the view. It starts that write without waiting for it, so the
// write can still be in flight when the view is destroyed below.
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
// this when the note lists change (livePreview.refreshWikilinks), so a
// detached background editor takes the redraw too and comes back drawn right.
export function allEditorViews(): EditorView[] {
  return [...pool.values()].map((e) => e.view);
}
