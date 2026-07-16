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
  runInline: (sessionId: string, id: string, code: string) => void;
  toggleTerminal: () => void;
  runInTerminal: (sessionId: string, code: string) => void;
  cancelRun: (sessionId: string) => void;
  resizeInline: (sessionId: string, cols: number, rows: number) => void;
  inputInline: (sessionId: string, data: string) => void;
}
const handlers: Partial<BridgeHandlers> = {};

export function configureBridge(fns: Partial<BridgeHandlers>): void {
  Object.assign(handlers, fns);
}

// Interrupt a note's inline run (Ctrl-C). Called by blocks.ts when it detects an
// inline block launched a full-screen program it cannot render.
export function cancelRun(sessionId: string): void {
  handlers.cancelRun?.(sessionId);
}

// Match a note's inline shell winsize to a block's rendered terminal grid. Called
// by the inline terminal as it fits to the editor width.
export function resizeInline(sessionId: string, cols: number, rows: number): void {
  handlers.resizeInline?.(sessionId, cols, rows);
}

// Forward keystrokes from a live block's inline terminal to the note's inline
// shell. Called by the inline terminal's onData while the block is running.
export function inputInline(sessionId: string, data: string): void {
  handlers.inputInline?.(sessionId, data);
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
    handlers.runInTerminal?.(m.sessionId, m.code);
    return;
  }
  if (m.id) handlers.runInline?.(m.sessionId, m.id, m.code);
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
