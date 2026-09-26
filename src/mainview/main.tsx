// The desktop entry point, Mac, Linux and Windows: the view over Electrobun's typed RPC.
//
// One of the three entry points (ios.md §1), beside ios.tsx's socket and
// harness.tsx's Map. boot.tsx holds everything the view does with a server.
// This file hands it Electrobun's request function.
import Electrobun, { Electroview } from "electrobun/view";
import type { LedgeRPC } from "../shared/rpc-schema";
import type { RequestClient } from "../shared/wire";
import { bootView, viewPush } from "./boot";
import { modKey } from "./commands/modKey";
import { configureShell } from "./lib/shell";

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

// The keyboard grammar is decided by modKey.ts from navigator.platform. What
// follows from it here: a desktop where Mod is Ctrl has no menu bar, so Quit
// is a command there (lib/shell.ts quitsByCommand, interactions.md §10). A Mac
// keeps the shell's defaults, whose Quit is the menu bar's.
//
// Windows' server is in WSL (bun/wslServer.ts), and `ledge` is already on
// WSL's PATH from server.sh, so Install Shell Command is left out there.
const WINDOWS = navigator.platform.startsWith("Win");
configureShell({ quitsByCommand: modKey() === "Ctrl", ...(WINDOWS ? { installsCli: false } : {}) });

// The cast says two derivations of LedgeRPC agree. It is not a claim about
// runtime shapes. Electrobun builds its per-method request map from the
// schema. RequestClient (wire.ts) is a mapped type over the same methods.
// `rpc` is non-null from construction.
void bootView(electrobun.rpc!.request as unknown as RequestClient);
