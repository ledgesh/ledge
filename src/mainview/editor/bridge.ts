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

// Set by main.tsx once the RPC channel is live.
let runInline: ((id: string, code: string) => void) | null = null;

export function configureBridge(fns: {
  runInline: (id: string, code: string) => void;
}): void {
  runInline = fns.runInline;
}

// Web -> Bun. Only inline runs are wired in this build; the other message types
// belonged to features (note persistence, the terminal drawer) that land in
// later steps, so they are intentional no-ops for now.
export function toNative(message: unknown): void {
  const m = message as NativeMessage;
  if (m.type !== "run") return;
  if (m.destination === "terminal") {
    console.info("[ledge] terminal-destination run is not wired yet");
    return;
  }
  if (m.id) runInline?.(m.id, m.code);
}

// Bun -> web run events. The editor registers a sink bound to its EditorView and
// main.tsx forwards each RPC `runEvent` message here.
let runEventSink: ((ev: RunEvent) => void) | null = null;

export function onRunEvent(sink: (ev: RunEvent) => void): () => void {
  runEventSink = sink;
  return () => {
    if (runEventSink === sink) runEventSink = null;
  };
}

export function dispatchRunEvent(ev: RunEvent): void {
  runEventSink?.(ev);
}
