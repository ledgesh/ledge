// The terminal drawer's side of the RPC. A module singleton, so the xterm
// component and the RPC wiring reach each other without prop-drilling through
// App (the configureX pattern, architecture.md §5). Input and resize go
// webview -> Bun; raw output comes back Bun -> webview. Shells are per note, so
// every call carries the note's `sessionId` (its docId): the drawer attaches
// to, types into, and resizes one note's shell.

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

// Wired by the view's boot once the RPC client exists (mainview/boot.tsx).
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
 * Turns on live streaming for a note and returns its scrollback bytes to
 * replay, plus the host the shell is on (what the drawer's badge shows). The
 * `host` argument is used only when this attach is what spawns the shell. A
 * live shell's host is fixed at birth (rpc-schema terminalAttach).
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
 * Reports whether the note's terminal shell is alive right now, and which host
 * it is on. The view asks before opening the drawer (or sending a block to it)
 * on a multi-host note. A shell that is already alive skips the picker:
 * opening the drawer or pasting into it can only reach the host that shell
 * is on (interactions.md §4a).
 */
export async function terminalStatus(sessionId: string): Promise<{ live: boolean; host: string | null }> {
  if (!statusFn) return { live: false, host: null };
  return statusFn(sessionId);
}

/**
 * Asks what became of an open drawer's shell while the wire was down
 * (rpc-schema terminalClaim). The drawer sends it after a reconnect, never at
 * boot: a drawer that is mounting attaches instead. "gone" means no shell is
 * left under the session: it exited, or another client restarted it. An
 * unconfigured seam answers "gone" too. A claim with no RPC behind it reads
 * to the caller as a shell that ended.
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

/** Encodes literal text (keystrokes) and sends it as input. */
export function sendTerminalText(sessionId: string, text: string): void {
  sendTerminalInput(sessionId, bytesToB64(encoder.encode(text)));
}

/**
 * Runs a block in the terminal as if it were pasted (rpc-schema
 * terminalPaste). Bun holds the text until the shell is ready, then wraps it
 * in bracketed-paste markers. Every line echoes together and runs under one
 * prompt. A shell that never announces that mode gets the text after a quiet
 * period instead, with no markers (bun/paste.ts takePaste). `language`, the
 * block's fence word, makes Bun paste an interpreted block's runner line
 * instead of raw code. Cmd+V pastes omit it.
 */
export function sendTerminalPaste(sessionId: string, text: string, language?: string | null, host?: string | null): void {
  sendPasteFn?.(sessionId, text, language, host);
}

export function sendTerminalResize(sessionId: string, cols: number, rows: number): void {
  sendResizeFn?.(sessionId, cols, rows);
}

/** Tears down both of a note's shells. Sent when its tab, its pane, or its
 * workspace closes and its docId drops out of the live set (App.tsx). */
export function closeSession(sessionId: string): void {
  closeSessionFn?.(sessionId);
}

/**
 * Kills both of a note's shells but keeps the tab and the session's params.
 * The next run or attach spawns fresh shells with the note's current
 * frontmatter params. This is what the Restart Note Shell command runs.
 */
export function restartSession(sessionId: string): void {
  restartSessionFn?.(sessionId);
}

// Bun -> webview raw pty output, tagged with the note it came from. The
// mounted xterm registers a sink and ignores output for a note other than the
// one it shows. A tab switch can bring output for both notes, and ignoring
// the note that is not shown does no harm.
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
// `exit`). App subscribes and closes the drawer when the shown note's shell
// quits.
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
// longer has it (rpc-schema terminalDetached). The mounted drawer subscribes
// and shows its notice. Nothing else does: the shell is still running and the
// note is otherwise unchanged. `by` is the id of the client that took it,
// which the drawer names from the presence list. This file passes the id
// along; naming clients is the connection chrome's job (lib/connections.ts
// labelFor).
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

// The wire came back. Unlike everything above it, this is not a push from Bun:
// the view raises it about its own connection (mainview/boot.tsx
// connectionState). It lives here because the drawer is its only subscriber:
// the mounted drawer answers by claiming its shell, which recovers the pushes
// dropped while the wire was down. A reconnect's other halves belong to their
// own modules, editor/bridge.ts reconcileRuns for the panels and
// lib/connections.ts for the bar.
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
