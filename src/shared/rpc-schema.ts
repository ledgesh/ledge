// The typed contract between the Bun main process and the editor webview.
// This replaces the hand-rolled window.webkit.messageHandlers bridge from the
// Swift build: the webview requests a block run, Bun streams run events back.

/** A streamed update about one running block, pushed Bun -> webview. */
export type RunEvent =
  | { id: string; kind: "began" }
  // Output bytes, base64-encoded because RPC payloads are JSON.
  | { id: string; kind: "output"; dataB64: string }
  | { id: string; kind: "ended"; exitCode: number };

export type LedgeRPC = {
  bun: {
    requests: {
      runBlock: { params: { id: string; code: string }; response: { accepted: boolean } };
      // Terminal drawer input and resize. Keystrokes and pasted text go through
      // terminalInput; the drawer's fit computes cols/rows for terminalResize.
      // These target a dedicated shell, separate from the inline-run shell.
      terminalInput: { params: { dataB64: string }; response: { ok: boolean } };
      terminalResize: { params: { cols: number; rows: number }; response: { ok: boolean } };
      // Attach returns the scrollback so far (so a freshly opened drawer shows the
      // existing prompt and history) and turns on live streaming; detach turns it
      // off while the drawer is closed. Scrollback keeps accumulating either way.
      terminalAttach: { params: {}; response: { dataB64: string } };
      terminalDetach: { params: {}; response: { ok: boolean } };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      runEvent: RunEvent;
      // Raw pty output for the terminal drawer, base64-encoded.
      terminalOutput: { dataB64: string };
    };
  };
};
