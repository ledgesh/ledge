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
  | { type: "ready" }
  | { type: "textChanged"; text: string }
  | { type: "focus" }
  | { type: "toggleTerminal" }
  | {
      type: "run";
      id?: string;
      code: string;
      language: string | null;
      destination: RunDestination;
    };

// Handlers are set from two places: main.tsx wires runInline (needs the RPC),
// and App wires the terminal-drawer callbacks (need React state). configureBridge
// merges, so either can set its own fields without clobbering the other.
interface BridgeHandlers {
  runInline: (id: string, code: string) => void;
  toggleTerminal: () => void;
  runInTerminal: (code: string) => void;
}
const handlers: Partial<BridgeHandlers> = {};

export function configureBridge(fns: Partial<BridgeHandlers>): void {
  Object.assign(handlers, fns);
}

// Web -> Bun. Note persistence (ready/textChanged/focus) has no native side yet,
// so those stay no-ops; run and terminal toggle are wired.
export function toNative(message: unknown): void {
  const m = message as NativeMessage;
  if (m.type === "toggleTerminal") {
    handlers.toggleTerminal?.();
    return;
  }
  if (m.type !== "run") return;
  if (m.destination === "terminal") {
    handlers.runInTerminal?.(m.code);
    return;
  }
  if (m.id) handlers.runInline?.(m.id, m.code);
}

// Bun -> web run events. Every mounted editor registers a sink bound to its own
// EditorView; a run event carries a globally-unique block id, and handleRunEvent
// is a silent no-op for ids a view doesn't own, so broadcasting to all sinks is
// safe and lets several editor tabs/panes coexist without routing bookkeeping.
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
