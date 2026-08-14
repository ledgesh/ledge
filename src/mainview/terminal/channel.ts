// The terminal drawer's side of the RPC, kept as a small module singleton so the
// xterm component and main.tsx can meet without prop-drilling through App. Input
// and resize go webview -> Bun; raw output comes back Bun -> webview. Every call
// carries the note's `sessionId` (its docId): shells are per note, so the drawer
// attaches to, types into, and resizes one note's terminal shell.

import type { TerminalClaim } from "../../shared/rpc-schema";

const encoder = new TextEncoder();

// base64 <-> bytes, byte-exact (terminal I/O is UTF-8 bytes, RPC payloads JSON).
export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let sendInputFn: ((sessionId: string, dataB64: string) => void) | null = null;
let sendPasteFn: ((sessionId: string, text: string, language?: string | null, host?: string | null) => void) | null = null;
let sendResizeFn: ((sessionId: string, cols: number, rows: number) => void) | null = null;
let attachFn: ((sessionId: string, host?: string | null) => Promise<{ dataB64: string; host: string }>) | null = null;
let detachFn: ((sessionId: string) => void) | null = null;
let statusFn: ((sessionId: string) => Promise<{ live: boolean; host: string | null }>) | null = null;
let claimFn: ((sessionId: string) => Promise<TerminalClaim>) | null = null;
let closeSessionFn: ((sessionId: string) => void) | null = null;
let restartSessionFn: ((sessionId: string) => void) | null = null;

// Wired by main.tsx once the Electroview RPC exists.
export function configureTerminal(fns: {
  sendInput: (sessionId: string, dataB64: string) => void;
  sendPaste: (sessionId: string, text: string, language?: string | null, host?: string | null) => void;
  sendResize: (sessionId: string, cols: number, rows: number) => void;
  attach: (sessionId: string, host?: string | null) => Promise<{ dataB64: string; host: string }>;
  detach: (sessionId: string) => void;
  status: (sessionId: string) => Promise<{ live: boolean; host: string | null }>;
  claim: (sessionId: string) => Promise<TerminalClaim>;
  closeSession: (sessionId: string) => void;
  restartSession: (sessionId: string) => void;
}): void {
  sendInputFn = fns.sendInput;
  sendPasteFn = fns.sendPaste;
  sendResizeFn = fns.sendResize;
  attachFn = fns.attach;
  detachFn = fns.detach;
  statusFn = fns.status;
  claimFn = fns.claim;
  closeSessionFn = fns.closeSession;
  restartSessionFn = fns.restartSession;
}

/**
 * Enable live streaming for a note and return its scrollback bytes to replay,
 * plus the host the shell is on (what the drawer's badge shows). `host` is
 * used only if this attach is the one that spawns the shell; a live shell's
 * host is fixed at its birth (rpc-schema terminalAttach).
 */
export async function terminalAttach(
  sessionId: string,
  host?: string | null,
): Promise<{ snapshot: Uint8Array; host: string }> {
  if (!attachFn) return { snapshot: new Uint8Array(0), host: "local" };
  const { dataB64, host: on } = await attachFn(sessionId, host);
  return { snapshot: b64ToBytes(dataB64), host: on };
}

/**
 * Whether the note's terminal shell is alive right now, and where. Asked
 * before opening the drawer (or sending a block to it) on a multi-host note:
 * only a spawn-to-be warrants the host picker.
 */
export async function terminalStatus(sessionId: string): Promise<{ live: boolean; host: string | null }> {
  if (!statusFn) return { live: false, host: null };
  return statusFn(sessionId);
}

/**
 * What became of an open drawer's shell while the wire was down (rpc-schema
 * terminalClaim). Sent by the drawer after a reconnect, never at boot: a drawer
 * that is mounting attaches instead.
 *
 * "gone" when there is nothing to ask, which is what an unconfigured seam
 * answers too — a claim with no RPC behind it has learned nothing, and the
 * caller treats the shell as ended rather than as still its own.
 */
export async function terminalClaim(sessionId: string): Promise<TerminalClaim> {
  if (!claimFn) return { state: "gone" };
  return claimFn(sessionId);
}

export function terminalDetach(sessionId: string): void {
  detachFn?.(sessionId);
}

export function sendTerminalInput(sessionId: string, dataB64: string): void {
  sendInputFn?.(sessionId, dataB64);
}

/** Convenience for sending literal text (keystrokes). */
export function sendTerminalText(sessionId: string, text: string): void {
  sendTerminalInput(sessionId, bytesToB64(encoder.encode(text)));
}

/**
 * Run a block in the terminal as if pasted. The Bun side wraps it in
 * bracketed-paste markers and holds it until the shell is ready, so all commands
 * echo together then run under one prompt (see rpc-schema terminalPaste).
 * `language` (the block's fence word) makes Bun paste an interpreted block's
 * runner line instead of its raw code; omit it for literal pastes (Cmd+V).
 */
export function sendTerminalPaste(sessionId: string, text: string, language?: string | null, host?: string | null): void {
  sendPasteFn?.(sessionId, text, language, host);
}

export function sendTerminalResize(sessionId: string, cols: number, rows: number): void {
  sendResizeFn?.(sessionId, cols, rows);
}

/** Tear down both of a note's shells (its tab closed). */
export function closeSession(sessionId: string): void {
  closeSessionFn?.(sessionId);
}

/**
 * Kill both of a note's shells but keep the tab (and the session's params):
 * the next run or attach spawns fresh shells with the note's current
 * frontmatter params. The "Restart Note Shell" command.
 */
export function restartSession(sessionId: string): void {
  restartSessionFn?.(sessionId);
}

// Bun -> webview raw pty output, tagged with the note it came from. The mounted
// xterm registers a sink and ignores output for a note other than the one it
// shows (harmless overlap during a tab switch).
let outputSink: ((sessionId: string, dataB64: string) => void) | null = null;

export function onTerminalOutput(sink: (sessionId: string, dataB64: string) => void): () => void {
  outputSink = sink;
  return () => {
    if (outputSink === sink) outputSink = null;
  };
}

export function dispatchTerminalOutput(sessionId: string, dataB64: string): void {
  outputSink?.(sessionId, dataB64);
}

// Bun -> webview: a note's terminal shell exited on its own (the user typed
// `exit`). App subscribes and closes the drawer when the shown note's shell quits.
let exitSink: ((sessionId: string) => void) | null = null;

export function onTerminalExit(sink: (sessionId: string) => void): () => void {
  exitSink = sink;
  return () => {
    if (exitSink === sink) exitSink = null;
  };
}

export function dispatchTerminalExit(sessionId: string): void {
  exitSink?.(sessionId);
}

// Bun -> webview: another client attached to this note's shell, so this one no
// longer has it (rpc-schema terminalDetached). The mounted drawer subscribes and
// shows its notice; nothing else in the view cares, since the shell is still
// running and the note is otherwise unaffected.
//
// `by` is the client id that took it, which the drawer turns into a name
// through the presence list (lib/connections.ts). Passed through rather than
// resolved here: this file moves messages, and what a client is called is the
// connection chrome's business.
let detachedSink: ((sessionId: string, by: string) => void) | null = null;

export function onTerminalDetached(sink: (sessionId: string, by: string) => void): () => void {
  detachedSink = sink;
  return () => {
    if (detachedSink === sink) detachedSink = null;
  };
}

export function dispatchTerminalDetached(sessionId: string, by: string): void {
  detachedSink?.(sessionId, by);
}

// The wire came back (mainview/boot.tsx connectionState). Not a message from
// Bun at all, unlike everything above it: this end raises it about its own
// connection, and it is here because the only subscriber is the drawer, beside
// the pushes it exists to recover.
//
// The mounted drawer answers by claiming its shell. Nothing else in the view
// subscribes — a reconnect's other halves belong to the modules that own them
// (editor/bridge.ts reconcileRuns for the panels, lib/connections.ts for the
// bar).
let relinkSink: (() => void) | null = null;

export function onTerminalRelink(sink: () => void): () => void {
  relinkSink = sink;
  return () => {
    if (relinkSink === sink) relinkSink = null;
  };
}

export function dispatchTerminalRelink(): void {
  relinkSink?.();
}
