// The web -> native channel. Native handlers live on `window.ledge` and are
// installed in editor.ts.
export function toNative(message: unknown): void {
  (window as unknown as {
    webkit?: { messageHandlers?: { ledge?: { postMessage(m: unknown): void } } };
  }).webkit?.messageHandlers?.ledge?.postMessage(message);
}

/// Where a block's output goes when it runs.
export type RunDestination = "inline" | "terminal";
