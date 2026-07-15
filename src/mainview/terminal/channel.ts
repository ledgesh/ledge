// The terminal drawer's side of the RPC, kept as a small module singleton so the
// xterm component and main.tsx can meet without prop-drilling through App. Input
// and resize go webview -> Bun; raw output comes back Bun -> webview.

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

let sendInputFn: ((dataB64: string) => void) | null = null;
let sendResizeFn: ((cols: number, rows: number) => void) | null = null;
let attachFn: (() => Promise<{ dataB64: string }>) | null = null;
let detachFn: (() => void) | null = null;

// Wired by main.tsx once the Electroview RPC exists.
export function configureTerminal(fns: {
  sendInput: (dataB64: string) => void;
  sendResize: (cols: number, rows: number) => void;
  attach: () => Promise<{ dataB64: string }>;
  detach: () => void;
}): void {
  sendInputFn = fns.sendInput;
  sendResizeFn = fns.sendResize;
  attachFn = fns.attach;
  detachFn = fns.detach;
}

// Enable live streaming and return the scrollback bytes to replay.
export async function terminalAttach(): Promise<Uint8Array> {
  if (!attachFn) return new Uint8Array(0);
  const { dataB64 } = await attachFn();
  return b64ToBytes(dataB64);
}

export function terminalDetach(): void {
  detachFn?.();
}

export function sendTerminalInput(dataB64: string): void {
  sendInputFn?.(dataB64);
}

/** Convenience for sending literal text (keystrokes, a "run in terminal" body). */
export function sendTerminalText(text: string): void {
  sendTerminalInput(bytesToB64(encoder.encode(text)));
}

export function sendTerminalResize(cols: number, rows: number): void {
  sendResizeFn?.(cols, rows);
}

// Bun -> webview raw pty output. The mounted xterm registers a sink.
let outputSink: ((dataB64: string) => void) | null = null;

export function onTerminalOutput(sink: (dataB64: string) => void): () => void {
  outputSink = sink;
  return () => {
    if (outputSink === sink) outputSink = null;
  };
}

export function dispatchTerminalOutput(dataB64: string): void {
  outputSink?.(dataB64);
}
