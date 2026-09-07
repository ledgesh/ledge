// The editor <-> Bun bridge for the Electrobun build. The Swift build went
// through window.webkit.messageHandlers; this one rides the typed Electrobun
// RPC. blocks.ts and setup.ts call `toNative(...)` either way, so the port
// needed no editor changes. bootView wires the two ends to the Electroview RPC
// main.tsx hands it (mainview/boot.tsx `configureBridge`).
import type { NoteMeta, RunEvent } from "../../shared/rpc-schema";
import type { TagInfo } from "../../shared/tags";
import type { ConfirmSpec } from "./fenceInfo";

/** Where a block's output goes when it runs. */
export type RunDestination = "inline" | "terminal";

/** One request to choose a target machine, anchored near what asked for it. */
export interface HostPickRequest {
  hosts: string[];
  // The session's last-picked host, preselected: a repeat run on the same
  // machine is Enter, and another machine has to be chosen from the list.
  preferred: string | null;
  anchor: { x: number; y: number };
  onPick: (host: string) => void;
}

/**
 * One request to confirm a run before it happens: the block carried `confirm`
 * on its fence, or its note declared `confirm: true` (interactions.md §4b).
 * Every run asks, like the host picker. Nothing here is cached and there is no
 * "don't ask again".
 */
export interface RunConfirmRequest {
  // The question from `confirm="…"`, or null for the default one.
  message: string | null;
  // What is about to run and where, so the dialog can show the code and name
  // the machine. `host` null means this machine, or, for the drawer's live
  // shell, wherever that shell already is (the drawer's badge names it).
  code: string;
  lang: string | null;
  host: string | null;
  destination: RunDestination;
  onConfirm: () => void;
}

/**
 * Ask before running. Fails closed: with no handler wired (an editor outside
 * the app) a marked block does not run. App always wires it.
 */
export function requestRunConfirm(req: RunConfirmRequest): void {
  handlers.confirmRun?.(req);
}

// The last host picked per session, view-side only and never persisted. It is
// a default for the picker, not state Bun acts on. A run names a host only
// when the view picked one, and Bun checks that name against the note's
// declared list (bun/server.ts resolveHost).
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
      // The note's declared host list, for the terminal destination. The
      // drawer's shell keeps one host for its whole life, so App decides
      // whether to ask once for the drawer, rather than each block deciding
      // here. `anchor` is where the asking block sits, so a picker that App
      // opens lands beside the click rather than across the window.
      hosts?: string[];
      anchor?: { x: number; y: number };
      // The block's confirm marker, for the terminal destination only. App
      // chooses the machine for the drawer, and the dialog comes after that
      // choice and never before it, so the question can name the machine
      // (interactions.md §4b). Inline runs resolve their host in blocks.ts and
      // open the dialog there.
      confirm?: ConfirmSpec | null;
    };

// Handlers are set from two places: bootView wires the ones that go straight
// to the RPC, such as runInline (mainview/boot.tsx), and App wires the
// terminal-drawer callbacks (they need React state). configureBridge merges,
// so either can set its own fields without clobbering the other.
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
  // Tell the server which inline runs this client can still show, and get back
  // the ones it is really running (inlineClaim; see reconcileRuns). Unwired
  // outside the app, where there is no server to be out of step with.
  claimRuns: (ids: string[]) => Promise<string[]>;
  resizeInline: (sessionId: string, id: string, cols: number, rows: number) => void;
  inputInline: (sessionId: string, id: string, data: string) => void;
  // Open the profile editor dialog (App owns it). editor/frontmatter.ts calls
  // this on a ⌘-clicked frontmatter profile name, and it opens the same dialog
  // as the "Edit Note Profile…" command.
  openProfileEditor: (name: string) => void;
  // Open a URL in the OS default handler (browser, mail). boot.tsx wires it
  // to the linkOpen RPC; Bun re-validates the scheme (shared/links.ts) before
  // anything reaches `open`.
  openLink: (url: string) => void;
  // The notes of the workspace folder the given doc belongs to. A wikilink
  // resolves against this list (editor/wikilinks.ts) and the `[[` picker shows
  // it. App wires it, since the store owns the lists. The snapshot is
  // synchronous because decoration passes cannot await.
  wikiNotes: (docId: string) => NoteMeta[];
  // Follow a wikilink: resolve `target` in the doc's own workspace and open
  // the note it names. App wires it, since dispatching openNote needs the
  // store. A dangling target is a no-op, never an error.
  openWikiNote: (docId: string, target: string) => void;
  // The doc's workspace tag directory, which is the `#` completion's
  // vocabulary (editor/tags.ts). App wires it to a per-folder snapshot it
  // keeps fresh. Synchronous for wikiNotes' reason: a completion source cannot
  // await a scan, and a slightly stale vocabulary is better than a popup that
  // stalls waiting for one.
  workspaceTags: (docId: string) => TagInfo[];
  // Follow a #tag: open the Tags panel drilled into it. App wires it to
  // ui.showTag, the same `tag.open` verb every other tag surface runs.
  openTag: (docId: string, tag: string) => void;
  // Surface a neutral one-liner (App wires it to ui.showNotice, the browser's
  // notice strip). The editor's refusals answer through this rather than
  // dropping the chord in silence (locking.md §7).
  notice: (message: string) => void;
}
const handlers: Partial<BridgeHandlers> = {};

export function configureBridge(fns: Partial<BridgeHandlers>): void {
  Object.assign(handlers, fns);
}

// Interrupt one inline run (Ctrl-C to its shell's foreground job). Runs can be
// concurrent, each on its own shell, so the run id names which one is
// interrupted. Called when a still-running block's output panel is dismissed.
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
// call from the editor into notes/store.ts, which owns its own RPC
// (notes/channel.ts).
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

// Bun -> web run events. Every mounted editor registers a sink bound to its
// own EditorView, and every event goes to every sink. handleRunEvent drops ids
// the view does not own (blocks.ts). Without that check one run's output would
// be written into a panel once per open note. Run ids are globally unique, so
// tabs and panes need no routing bookkeeping.

/**
 * One mounted editor's end of the run channel: where a run event goes, and
 * which of its runs are still going. `live` sits here rather than in a
 * registry of its own because an editor that no longer receives events has no
 * panel showing its runs, and those are the runs reconcileRuns must not claim.
 */
export interface RunSink {
  apply(ev: RunEvent): void;
  live(): string[];
  /** The wire to the machine these runs are on dropped, or came back
   * (blocks.ts setRunsLink). Here for the same reason as `live`: an editor's
   * runs, what it claims of them, and what it can be told about them share a
   * lifetime. */
  link(up: boolean): void;
}

const runEventSinks = new Set<RunSink>();

export function onRunEvent(sink: RunSink): () => void {
  runEventSinks.add(sink);
  return () => {
    runEventSinks.delete(sink);
  };
}

export function dispatchRunEvent(ev: RunEvent): void {
  for (const sink of runEventSinks) sink.apply(ev);
}

/**
 * Tell every panel that the connection dropped or came back
 * (mainview/boot.tsx). Every sink hears it, not only the note in front,
 * because a run outlives the tab showing it: a background note running a
 * deploy would otherwise sit on "Running" for the whole outage.
 *
 * Paired with reconcileRuns and called before it on the way up. The order is
 * not what makes it correct: runningRunIds counts unknown runs alongside
 * running ones, so a claim from either side of this names the same ids.
 */
export function dispatchRunLink(up: boolean): void {
  for (const sink of runEventSinks) sink.link(up);
}

/**
 * Line this client's inline runs up with the server's. Called once at boot and
 * again on every reconnect (mainview/boot.tsx), which are the moments the two
 * ends can have drifted apart. They drift in both directions, and one half of
 * this exchange fixes each (remote.md §7).
 *
 * Naming the runs that still have panels lets the server interrupt the rest.
 * A reload takes every panel with it, and those runs would otherwise keep
 * executing with no id left anywhere to stop them by.
 *
 * The other half is the answer itself. A dropped connection can leave this
 * client showing a run the server has already finished. This call closes such
 * a run out with no exit status, the same shape as a run whose shell exits
 * under it (bun/inlinePool.ts). The server holds run output for an absent
 * client and releases it ahead of the answer (bun/server.ts `missed`), so an
 * ordinary outage returns the real ending instead. An ending sent before the
 * server noticed the wire was dead is lost.
 */
export async function reconcileRuns(): Promise<void> {
  const claim = handlers.claimRuns;
  if (!claim) return;
  const ids = [...new Set([...runEventSinks].flatMap((sink) => sink.live()))];
  let running: string[];
  try {
    running = await claim(ids);
  } catch {
    // The wire dropped again mid-question. The connection that replaces this
    // one asks again, and until then nothing is claimed or closed out.
    return;
  }
  const alive = new Set(running);
  // Asked again rather than reusing `ids`, because the answer may arrive
  // behind output the server was holding for this client, including the
  // `ended` that closed a run out properly (remote.md §7). Such a run is gone
  // from this set, and ending it a second time would replace its real exit
  // code with the blank "Session ended".
  const still = new Set([...runEventSinks].flatMap((sink) => sink.live()));
  for (const id of ids) {
    if (!alive.has(id) && still.has(id)) dispatchRunEvent({ id, kind: "ended", exitCode: null });
  }
}

// --- terminal-shell busy state ----------------------------------------------
//
// Which notes' terminal shells are mid-job, pushed from Bun (terminalBusy in
// rpc-schema.ts). The block chrome reads this to gray out its terminal button:
// a block sent to a busy shell is queued rather than run, the queue shows
// nowhere else, and an ungrayed button gets pressed a second time.
//
// Absent means free, so a note whose shell has never been opened, or whose
// shell is gone, reads as ready without needing an entry.
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

// Run `sink` whenever any shell's busy state changes, so the chrome can
// re-render.
export function onTerminalBusyChange(sink: () => void): () => void {
  busySinks.add(sink);
  return () => {
    busySinks.delete(sink);
  };
}
