import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Electrobun, { Electroview } from "electrobun/view";
import type { LedgeRPC } from "../shared/rpc-schema";
import { configureBridge, dispatchRunEvent } from "./editor/bridge";
import { configureTerminal, dispatchTerminalOutput } from "./terminal/channel";
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
      terminalOutput: ({ dataB64 }) => dispatchTerminalOutput(dataB64),
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

configureBridge({
  runInline: (id, code) => {
    void electrobun.rpc!.request.runBlock({ id, code });
  },
});

configureTerminal({
  sendInput: (dataB64) => {
    void electrobun.rpc!.request.terminalInput({ dataB64 });
  },
  sendResize: (cols, rows) => {
    void electrobun.rpc!.request.terminalResize({ cols, rows });
  },
  attach: () => electrobun.rpc!.request.terminalAttach({}),
  detach: () => {
    void electrobun.rpc!.request.terminalDetach({});
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
