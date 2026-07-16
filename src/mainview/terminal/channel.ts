// The terminal drawer's side of the RPC, kept as a small module singleton so the
// xterm component and main.tsx can meet without prop-drilling through App. Input
// and resize go webview -> Bun; raw output comes back Bun -> webview. Every call
// carries the note's `sessionId` (its docId): shells are per note, so the drawer
// attaches to, types into, and resizes one note's terminal shell.

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
let sendResizeFn: ((sessionId: string, cols: number, rows: number) => void) | null = null;
let attachFn: ((sessionId: string) => Promise<{ dataB64: string }>) | null = null;
let detachFn: ((sessionId: string) => void) | null = null;
let closeSessionFn: ((sessionId: string) => void) | null = null;

// Wired by main.tsx once the Electroview RPC exists.
export function configureTerminal(fns: {
  sendInput: (sessionId: string, dataB64: string) => void;
  sendResize: (sessionId: string, cols: number, rows: number) => void;
  attach: (sessionId: string) => Promise<{ dataB64: string }>;
  detach: (sessionId: string) => void;
  closeSession: (sessionId: string) => void;
}): void {
  sendInputFn = fns.sendInput;
  sendResizeFn = fns.sendResize;
  attachFn = fns.attach;
  detachFn = fns.detach;
  closeSessionFn = fns.closeSession;
}

// Enable live streaming for a note and return its scrollback bytes to replay.
export async function terminalAttach(sessionId: string): Promise<Uint8Array> {
  if (!attachFn) return new Uint8Array(0);
  const { dataB64 } = await attachFn(sessionId);
  return b64ToBytes(dataB64);
}

export function terminalDetach(sessionId: string): void {
  detachFn?.(sessionId);
}

export function sendTerminalInput(sessionId: string, dataB64: string): void {
  sendInputFn?.(sessionId, dataB64);
}

/** Convenience for sending literal text (keystrokes, a "run in terminal" body). */
export function sendTerminalText(sessionId: string, text: string): void {
  sendTerminalInput(sessionId, bytesToB64(encoder.encode(text)));
}

export function sendTerminalResize(sessionId: string, cols: number, rows: number): void {
  sendResizeFn?.(sessionId, cols, rows);
}

/** Tear down both of a note's shells (its tab closed). */
export function closeSession(sessionId: string): void {
  closeSessionFn?.(sessionId);
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
