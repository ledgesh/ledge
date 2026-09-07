// The Mac entry point: the view over Electrobun's typed RPC.
//
// One of the three entry points (ios.md §1), beside ios.tsx's socket and
// harness.tsx's Map. boot.tsx holds everything the view does with a server.
// This file hands it Electrobun's request function.
import Electrobun, { Electroview } from "electrobun/view";
import type { LedgeRPC } from "../shared/rpc-schema";
import type { RequestClient } from "../shared/wire";
import { bootView, viewPush } from "./boot";

// The webview end of the typed RPC. Bun pushes `runEvent` and `terminalOutput`
// messages here. The editor and terminal send requests the other way. The
// message map is `viewPush`, the view's push object: the names are the
// schema's on both sides, so there is nothing to translate.
const rpc = Electroview.defineRPC<LedgeRPC>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: viewPush,
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// The cast says two derivations of LedgeRPC agree. It is not a claim about
// runtime shapes. Electrobun builds its per-method request map from the
// schema. RequestClient (wire.ts) is a mapped type over the same methods.
// `rpc` is non-null from construction.
void bootView(electrobun.rpc!.request as unknown as RequestClient);
