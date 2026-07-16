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
      // Shells are per note: `sessionId` is the tab's stable docId. The Bun side
      // lazily spawns that note's inline-run shell on first runBlock and closes it
      // on closeSession, so a `cd` in one note never leaks into another.
      runBlock: { params: { sessionId: string; id: string; code: string }; response: { accepted: boolean } };
      // Terminal drawer input and resize, targeting one note's terminal shell.
      // Keystrokes and pasted text go through terminalInput; the drawer's fit
      // computes cols/rows for terminalResize. This shell is separate from the
      // note's inline-run shell (the marker protocol stays isolated from raw xterm).
      terminalInput: { params: { sessionId: string; dataB64: string }; response: { ok: boolean } };
      terminalResize: { params: { sessionId: string; cols: number; rows: number }; response: { ok: boolean } };
      // Attach lazily spawns the note's terminal shell (if needed), returns the
      // scrollback so far (so a freshly opened drawer shows the existing prompt and
      // history) and turns on live streaming; detach turns it off while the drawer
      // is closed or shows another note. Scrollback keeps accumulating either way.
      terminalAttach: { params: { sessionId: string }; response: { dataB64: string } };
      terminalDetach: { params: { sessionId: string }; response: { ok: boolean } };
      // Tear down both of a note's shells; sent when its tab (or pane, or
      // workspace) closes and its docId drops out of the live set.
      closeSession: { params: { sessionId: string }; response: { ok: boolean } };
      // System clipboard, routed through the Bun process (pbcopy/pbpaste). The
      // webview runs under the views:// scheme, which is not a secure context, so
      // navigator.clipboard is unavailable and execCommand / native Cmd+V paste
      // are unreliable without a native Edit menu. Going through Bun sidesteps all
      // of that and behaves like a normal terminal's copy/paste.
      clipboardWrite: { params: { text: string }; response: { ok: boolean } };
      clipboardRead: { params: {}; response: { text: string } };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      runEvent: RunEvent;
      // Raw pty output for one note's terminal drawer, base64-encoded. `sessionId`
      // lets the mounted drawer ignore output from a note other than the one it
      // currently shows (e.g. brief overlap during a tab switch).
      terminalOutput: { sessionId: string; dataB64: string };
      // A note's terminal shell exited on its own (the user typed `exit`). The Bun
      // side has already torn the shell down; the view closes the drawer if it is
      // showing that note. Reopening the drawer spawns a fresh shell.
      terminalExit: { sessionId: string };
    };
  };
};
