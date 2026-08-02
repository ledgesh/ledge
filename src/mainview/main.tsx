// The Mac shell's entry point: Electrobun's RPC, and nothing else.
//
// Everything the view does with a server is boot.tsx, which this hands one to.
// What is left here is the one thing that is true of this shell and no other —
// that the server is reachable through Electrobun's typed RPC rather than
// through a socket (ios.tsx) or a Map (harness.tsx).
import Electrobun, { Electroview } from "electrobun/view";
import type { LedgeRPC } from "../shared/rpc-schema";
import type { RequestClient } from "../shared/wire";
import { bootView, viewPush } from "./boot";

// The webview end of the typed RPC. Bun pushes `runEvent` and `terminalOutput`
// messages here; the editor and terminal send requests the other way. The
// message map IS the view's push object: the names are the schema's on both
// sides, so there is nothing to translate.
const rpc = Electroview.defineRPC<LedgeRPC>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: viewPush,
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// Electrobun builds the same per-method map from the same schema, so the cast
// is a statement that two derivations of one type agree, not a claim about
// shapes. `rpc` is non-null from construction.
void bootView(electrobun.rpc!.request as unknown as RequestClient);
