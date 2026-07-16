// The keep-alive editor pool.
//
// In the Swift build, Bonsplit ran with `contentViewLifecycle: .keepAllAlive`
// because the editor is expensive to rebuild: throwing it away on a tab switch
// would lose the caret, scroll, undo stack, and inline run output. React's normal
// mount/unmount would do exactly that. So editors live here, keyed by a stable
// `docId`, outside the React tree: switching tabs only re-parents a view's DOM
// host into the newly-visible pane; it never destroys the view. A view is torn
// down only when its tab is closed (releaseEditor).
import type { EditorView } from "@codemirror/view";
import { createEditor } from "../editor/setup";
import { handleRunEvent, pingOverlay } from "../editor/blocks";
import { onRunEvent } from "../editor/bridge";
import type { RunEvent } from "../../shared/rpc-schema";

// Seed content. The very first tab shows the demo note (the whole run loop on
// first launch); every other tab opens as a near-empty scratch note. Built from
// lines so the ``` fences don't collide with JS backticks.
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

// Get (creating on first use) the pooled editor for `docId`. The returned host is
// a detached <div> until attachEditor parents it into a pane.
function acquire(docId: string, seed: "demo" | "scratch"): Entry {
  const existing = pool.get(docId);
  if (existing) return existing;

  const host = document.createElement("div");
  host.className = "ledge-editor-host";
  const view = createEditor(host, seedDoc(seed));
  const offRun = onRunEvent((ev) => applyRunEvent(view, ev));
  // CodeMirror does not watch its container for size changes; a pane resize (a
  // divider drag, the terminal drawer opening) needs an explicit re-measure.
  const ro = new ResizeObserver(() => view.requestMeasure());
  ro.observe(host);

  const entry: Entry = { host, view, offRun, ro };
  pool.set(docId, entry);
  return entry;
}

// Parent the editor's host into `container` and re-pin its overlay. Returns the
// live EditorView so the caller can focus it.
export function attachEditor(container: HTMLElement, docId: string, seed: "demo" | "scratch"): EditorView {
  const entry = acquire(docId, seed);
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

// Tear an editor down for good. Called when a tab is closed.
export function releaseEditor(docId: string): void {
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
