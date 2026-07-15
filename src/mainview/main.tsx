import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Electrobun, { Electroview } from "electrobun/view";
import type { LedgeRPC } from "../shared/rpc-schema";
import { configureBridge, dispatchRunEvent } from "./editor/bridge";
import "./index.css";
import App from "./App";

// The webview end of the typed RPC. Bun pushes `runEvent` messages here; the
// editor sends `runBlock` requests the other way (wired via configureBridge).
const rpc = Electroview.defineRPC<LedgeRPC>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      runEvent: (ev) => dispatchRunEvent(ev),
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

configureBridge({
  runInline: (id, code) => {
    void electrobun.rpc!.request.runBlock({ id, code });
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
