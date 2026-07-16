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
import type { EditorView } from "@codemirror/view";
import { createEditor } from "../editor/setup";
import { handleRunEvent, pingOverlay } from "../editor/blocks";
import { onRunEvent } from "../editor/bridge";
import { fromDisk } from "../editor/session";
import { readNote } from "../notes/channel";
import { bindDoc, releaseDoc, seedSlug, type DocHandlers } from "../notes/store";
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

const SCRATCH_DOC = ["# Untitled", "", "```sh", 'echo "ready"', "```", ""].join("\n");

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
}

const pool = new Map<string, Entry>();

// Pour a note's saved text into its (empty, freshly-created) editor. The read is
// async, so the editor exists first and the content arrives a beat later; the
// alternative, holding the pane blank until the file lands, would make every tab
// switch to an unopened note flicker.
//
// `fromDisk` keeps the change listener from treating the load as an edit and
// saving it straight back, and it stays out of the undo history so the first
// Cmd+Z in a note cannot wipe it back to empty.
async function loadNote(docId: string, path: string): Promise<void> {
  const text = await readNote(path);
  if (text === null) return; // note is gone; leave the editor empty rather than guess
  // Before the text reaches the editor, tell the save controller which heading this
  // note ALREADY has. Filenames follow the H1 from here on, and without this the
  // load itself would look like the heading appearing from nowhere and move the
  // file. A note only gets renamed by a heading you edit, never by one you open.
  seedSlug(docId, text);
  const entry = pool.get(docId);
  if (!entry) return; // the tab closed while the read was in flight
  entry.view.dispatch({
    changes: { from: 0, to: entry.view.state.doc.length, insert: text },
    annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
  });
}

// Get (creating on first use) the pooled editor for a tab's note. The returned
// host is a detached <div> until attachEditor parents it into a pane.
function acquire(tab: TabState, handlers: DocHandlers): Entry {
  const { docId } = tab;
  // Rebind on every acquire: the entry may predate this callback's closure, and
  // an already-open note keeps whatever dirty state, path, and seeded slug it has.
  bindDoc(docId, tab.path, handlers);
  const existing = pool.get(docId);
  if (existing) return existing;

  const host = document.createElement("div");
  host.className = "ledge-editor-host";
  const view = createEditor(host, tab.path ? "" : seedDoc(tab.seed), docId);
  const offRun = onRunEvent((ev) => applyRunEvent(view, ev));
  // CodeMirror does not watch its container for size changes; a pane resize (a
  // divider drag, the terminal drawer opening) needs an explicit re-measure.
  const ro = new ResizeObserver(() => view.requestMeasure());
  ro.observe(host);

  const entry: Entry = { host, view, offRun, ro };
  pool.set(docId, entry);
  if (tab.path) void loadNote(docId, tab.path);
  return entry;
}

// Parent the editor's host into `container` and re-pin its overlay. Returns the
// live EditorView so the caller can focus it. `handlers` carries the two ways a
// note's name can move: its file appearing or being renamed to follow its H1
// (onFile), and its on-screen label changing (onTitle).
export function attachEditor(container: HTMLElement, tab: TabState, handlers: DocHandlers): EditorView {
  const entry = acquire(tab, handlers);
  if (entry.host.parentElement !== container) container.appendChild(entry.host);
  entry.view.requestMeasure();
  pingOverlay(entry.view);
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
