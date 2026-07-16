import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Electrobun, { Electroview } from "electrobun/view";
import type { LedgeRPC } from "../shared/rpc-schema";
import { configureBridge, dispatchRunEvent } from "./editor/bridge";
import { configureTerminal, dispatchTerminalOutput, dispatchTerminalExit } from "./terminal/channel";
import { configureClipboard } from "./lib/clipboard";
import "./index.css";
import App from "./App";

// The webview end of the typed RPC. Bun pushes `runEvent` and `terminalOutput`
// messages here; the editor and terminal send requests the other way.
const rpc = Electroview.defineRPC<LedgeRPC>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      runEvent: (ev) => dispatchRunEvent(ev),
      terminalOutput: ({ sessionId, dataB64 }) => dispatchTerminalOutput(sessionId, dataB64),
      terminalExit: ({ sessionId }) => dispatchTerminalExit(sessionId),
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

configureBridge({
  runInline: (sessionId, id, code) => {
    void electrobun.rpc!.request.runBlock({ sessionId, id, code });
  },
});

configureTerminal({
  sendInput: (sessionId, dataB64) => {
    void electrobun.rpc!.request.terminalInput({ sessionId, dataB64 });
  },
  sendResize: (sessionId, cols, rows) => {
    void electrobun.rpc!.request.terminalResize({ sessionId, cols, rows });
  },
  attach: (sessionId) => electrobun.rpc!.request.terminalAttach({ sessionId }),
  detach: (sessionId) => {
    void electrobun.rpc!.request.terminalDetach({ sessionId });
  },
  closeSession: (sessionId) => {
    void electrobun.rpc!.request.closeSession({ sessionId });
  },
});

configureClipboard({
  write: (text) => {
    void electrobun.rpc!.request.clipboardWrite({ text });
  },
  read: () => electrobun.rpc!.request.clipboardRead({}).then((r) => r.text),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
