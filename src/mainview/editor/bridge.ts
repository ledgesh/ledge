// The editor <-> Bun bridge for the Electrobun build.
//
// In the Swift build this went through window.webkit.messageHandlers; here it
// rides the typed Electrobun RPC. blocks.ts and setup.ts still call the same
// `toNative(...)` they always did, so the editor code is unchanged. main.tsx
// wires the two ends once the Electroview RPC exists.
import type { RunEvent } from "../../shared/rpc-schema";

/** Where a block's output goes when it runs. */
export type RunDestination = "inline" | "terminal";

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
    };

// Handlers are set from two places: main.tsx wires runInline (needs the RPC),
// and App wires the terminal-drawer callbacks (need React state). configureBridge
// merges, so either can set its own fields without clobbering the other.
interface BridgeHandlers {
  runInline: (sessionId: string, id: string, code: string, language: string | null) => void;
  toggleTerminal: () => void;
  runInTerminal: (sessionId: string, code: string, language: string | null) => void;
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

// Open the profile editor on `name` (editor/frontmatter.ts's ⌘-click).
export function editProfile(name: string): void {
  handlers.openProfileEditor?.(name);
}

// Open `url` outside the app (editor/livePreview.ts's ⌘-click and the "Open
// Link" command).
export function openExternal(url: string): void {
  handlers.openLink?.(url);
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
    handlers.runInTerminal?.(m.sessionId, m.code, m.language);
    return;
  }
  if (m.id) handlers.runInline?.(m.sessionId, m.id, m.code, m.language);
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
