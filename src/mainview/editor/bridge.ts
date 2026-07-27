// The editor <-> Bun bridge for the Electrobun build.
//
// In the Swift build this went through window.webkit.messageHandlers; here it
// rides the typed Electrobun RPC. blocks.ts and setup.ts still call the same
// `toNative(...)` they always did, so the editor code is unchanged. main.tsx
// wires the two ends once the Electroview RPC exists.
import type { NoteMeta, RunEvent } from "../../shared/rpc-schema";
import type { TagInfo } from "../../shared/tags";
import type { ConfirmSpec } from "./fenceInfo";

/** Where a block's output goes when it runs. */
export type RunDestination = "inline" | "terminal";

/** One request to choose a target machine, anchored near what asked for it. */
export interface HostPickRequest {
  hosts: string[];
  // The session's last-picked host, preselected so a repeat run on the same
  // machine is Enter; running on a DIFFERENT machine takes a deliberate move.
  preferred: string | null;
  anchor: { x: number; y: number };
  onPick: (host: string) => void;
}

/**
 * One request to confirm a run before it happens: the block carried `confirm`
 * on its fence, or its note declared `confirm: true` (interactions.md §4b).
 * Always-ask, like the host picker and for the same reason — a remembered yes
 * is exactly the state the marker exists to prevent — so nothing here is
 * cached and there is no "don't ask again".
 */
export interface RunConfirmRequest {
  // The question from `confirm="…"`, or null for the default one.
  message: string | null;
  // What is about to run and where, so the dialog can show the code and name
  // the machine. `host` null means this machine (or, for the drawer's live
  // shell, wherever it already is: the badge says).
  code: string;
  lang: string | null;
  host: string | null;
  destination: RunDestination;
  onConfirm: () => void;
}

/**
 * Ask before running. Fails CLOSED: with no handler wired (an editor outside
 * the app), a marked block does not run. App always wires it.
 */
export function requestRunConfirm(req: RunConfirmRequest): void {
  handlers.confirmRun?.(req);
}

// The last host picked per session, view-side only and never persisted: it is
// a convenience default for the picker, not state Bun acts on — every actual
// run still names its host explicitly and is validated Bun-side.
const lastHost = new Map<string, string>();

export function lastHostFor(sessionId: string): string | null {
  return lastHost.get(sessionId) ?? null;
}

/** Ask the user which declared host to target, remembering the answer. */
export function requestHostPick(sessionId: string, req: Omit<HostPickRequest, "preferred">): void {
  handlers.pickHost?.({
    ...req,
    preferred: lastHostFor(sessionId),
    onPick: (host) => {
      lastHost.set(sessionId, host);
      req.onPick(host);
    },
  });
}

type NativeMessage =
  | { type: "toggleTerminal" }
  | {
      type: "run";
      // The note the block belongs to, so the run reaches that note's shell.
      sessionId: string;
      id?: string;
      code: string;
      language: string | null;
      destination: RunDestination;
      // The machine picked for an inline run (the host picker, or the note's
      // single declared host), null for local/undeclared. Bun re-validates it
      // against the note's declared list either way.
      host?: string | null;
      // The note's declared host list, for the TERMINAL destination: the
      // drawer's shell has one host for its whole life, so whether to ask is
      // decided where the drawer lives (App), not per block here. `anchor` is
      // where the asking block sits, so the picker App may open lands beside
      // the click instead of across the window.
      hosts?: string[];
      anchor?: { x: number; y: number };
      // The block's confirm marker, for the TERMINAL destination only: the
      // machine is chosen where the drawer lives (App), and the dialog must
      // come AFTER that choice so it can name the machine. Inline runs resolve
      // their host in blocks.ts and open the dialog there.
      confirm?: ConfirmSpec | null;
    };

// Handlers are set from two places: main.tsx wires runInline (needs the RPC),
// and App wires the terminal-drawer callbacks (need React state). configureBridge
// merges, so either can set its own fields without clobbering the other.
interface BridgeHandlers {
  runInline: (sessionId: string, id: string, code: string, language: string | null, host: string | null) => void;
  toggleTerminal: () => void;
  runInTerminal: (
    sessionId: string,
    code: string,
    language: string | null,
    hosts: string[],
    anchor?: { x: number; y: number },
    confirm?: ConfirmSpec | null,
  ) => void;
  // Open the run confirmation dialog (App renders it). `onConfirm` fires on
  // the confirm button; cancelling and dismissing fire nothing.
  confirmRun: (req: RunConfirmRequest) => void;
  // Open the anchored host-picker popover (App renders it): the note declares
  // more than one host, so the user chooses before anything executes.
  // `onPick` fires with the chosen host; dismissal fires nothing.
  pickHost: (req: HostPickRequest) => void;
  cancelRun: (sessionId: string, id: string) => void;
  resizeInline: (sessionId: string, id: string, cols: number, rows: number) => void;
  inputInline: (sessionId: string, id: string, data: string) => void;
  // Open the profile editor dialog (App owns it). The editor calls this when
  // the ⌘-clicked frontmatter profile name asks for the same dialog the
  // "Edit Note Profile…" command opens.
  openProfileEditor: (name: string) => void;
  // Open a URL in the OS default handler (browser, mail). main.tsx wires it
  // to the linkOpen RPC; Bun re-validates the scheme (shared/links.ts) before
  // anything reaches `open`.
  openLink: (url: string) => void;
  // The notes of the workspace folder the given doc belongs to — what a
  // wikilink resolves against (editor/wikilinks.ts) and what the `[[` picker
  // lists. App wires it (the store owns the lists); a synchronous snapshot,
  // because decoration passes cannot await.
  wikiNotes: (docId: string) => NoteMeta[];
  // Follow a wikilink: resolve `target` in the doc's own workspace and open
  // the note it names (App wires it — dispatching openNote needs the store).
  // A dangling target is a no-op, never an error.
  openWikiNote: (docId: string, target: string) => void;
  // The doc's workspace tag directory — the `#` completion's vocabulary
  // (editor/tags.ts). App wires it to a per-folder snapshot it keeps fresh;
  // synchronous for wikiNotes' reason: completion sources cannot await a
  // scan, and a slightly stale vocabulary beats a popup that stalls.
  workspaceTags: (docId: string) => TagInfo[];
  // Follow a #tag: open the Tags panel drilled into it (App wires it to
  // ui.showTag — the same tag.open verb every other tag surface runs).
  openTag: (docId: string, tag: string) => void;
  // Surface a neutral one-liner (App wires it to ui.showNotice — the
  // browser's notice strip). The editor's refusals speak through this: a
  // swallowed chord diagnoses nothing (locking.md §7).
  notice: (message: string) => void;
}
const handlers: Partial<BridgeHandlers> = {};

export function configureBridge(fns: Partial<BridgeHandlers>): void {
  Object.assign(handlers, fns);
}

// Interrupt one inline run (Ctrl-C to its shell's foreground job). Runs can be
// concurrent, each on its own shell, so the run id names which one dies. Called
// when a still-running block's output panel is dismissed.
export function cancelRun(sessionId: string, id: string): void {
  handlers.cancelRun?.(sessionId, id);
}

// Match the winsize of the shell executing run `id` to the block's rendered
// terminal grid. Called by the inline terminal as it fits to the editor width.
export function resizeInline(sessionId: string, id: string, cols: number, rows: number): void {
  handlers.resizeInline?.(sessionId, id, cols, rows);
}

// Forward keystrokes from a live block's inline terminal to the shell executing
// that run. Called by the inline terminal's onData while the block is running.
export function inputInline(sessionId: string, id: string, data: string): void {
  handlers.inputInline?.(sessionId, id, data);
}

// Surface a neutral one-line notice (the browser's strip).
export function notifyUser(message: string): void {
  handlers.notice?.(message);
}

// Open the profile editor on `name` (editor/frontmatter.ts's ⌘-click).
export function editProfile(name: string): void {
  handlers.openProfileEditor?.(name);
}

// Open `url` outside the app (editor/livePreview.ts's ⌘-click and the "Open
// Link" command).
export function openExternal(url: string): void {
  handlers.openLink?.(url);
}

// The wikilink resolution set for a doc's workspace (editor/wikilinks.ts).
// Empty when unconfigured (an editor outside the app, e.g. a unit test):
// every link is dangling rather than anything throwing mid-decoration.
export function wikiNotes(docId: string): NoteMeta[] {
  return handlers.wikiNotes?.(docId) ?? [];
}

// Follow a wikilink in `docId`'s note (livePreview.ts click/hotspot and the
// "Open Link" command).
export function openWikiNote(docId: string, target: string): void {
  handlers.openWikiNote?.(docId, target);
}

// The tag vocabulary for a doc's workspace (editor/tags.ts completion).
// Empty when unconfigured, wikiNotes' stance: no popup rather than a throw.
export function workspaceTags(docId: string): TagInfo[] {
  return handlers.workspaceTags?.(docId) ?? [];
}

// Follow a #tag in `docId`'s note (livePreview.ts click/hotspot, the "Open
// Link" command, and the frontmatter tags: line's ⌘-click).
export function openTag(docId: string, tag: string): void {
  handlers.openTag?.(docId, tag);
}

// Web -> Bun. Note edits do not come through here: persistence is a direct
// call from the editor into notes/store.ts, which owns its own RPC (notes/channel).
export function toNative(message: unknown): void {
  const m = message as NativeMessage;
  if (m.type === "toggleTerminal") {
    handlers.toggleTerminal?.();
    return;
  }
  if (m.type !== "run") return;
  if (m.destination === "terminal") {
    handlers.runInTerminal?.(m.sessionId, m.code, m.language, m.hosts ?? [], m.anchor, m.confirm ?? null);
    return;
  }
  if (m.id) handlers.runInline?.(m.sessionId, m.id, m.code, m.language, m.host ?? null);
}

// Bun -> web run events. Every mounted editor registers a sink bound to its own
// EditorView; a run event carries a globally-unique block id, and handleRunEvent
// drops ids the view doesn't own, so broadcasting to all sinks is safe and lets
// several editor tabs/panes coexist without routing bookkeeping. That check is
// what makes the broadcast safe rather than merely convenient: without it every
// open note re-writes the same output into the one panel that shows it.
const runEventSinks = new Set<(ev: RunEvent) => void>();

export function onRunEvent(sink: (ev: RunEvent) => void): () => void {
  runEventSinks.add(sink);
  return () => {
    runEventSinks.delete(sink);
  };
}

export function dispatchRunEvent(ev: RunEvent): void {
  for (const sink of runEventSinks) sink(ev);
}

// --- terminal-shell busy state ----------------------------------------------
//
// Which notes' terminal shells are mid-job, pushed from Bun (see terminalBusy in
// rpc-schema.ts). The block chrome reads this to gray out its terminal button:
// a block sent to a busy shell waits in a queue, and a queue nobody can see is
// what makes people click the button again.
//
// Absent means free, so a note whose shell has never been opened, or whose shell
// is gone, reads as ready without needing an entry.
const termBusy = new Set<string>();
const busySinks = new Set<() => void>();

export function setTerminalBusy(sessionId: string, busy: boolean): void {
  if (busy === termBusy.has(sessionId)) return;
  if (busy) termBusy.add(sessionId);
  else termBusy.delete(sessionId);
  for (const sink of busySinks) sink();
}

export function isTerminalBusy(sessionId: string): boolean {
  return termBusy.has(sessionId);
}

// Ping me when any shell's busy state changes, so the chrome can re-render.
export function onTerminalBusyChange(sink: () => void): () => void {
  busySinks.add(sink);
  return () => {
    busySinks.delete(sink);
  };
}
