// `ledge-server serve`: the Ledge server on stdin and stdout (remote.md §3).
//
// The same createServer() the Mac app runs in-process, with a frame codec
// where the Electrobun RPC would be. A remote client reaches it as
// `ssh <target> ledge-server serve`; a local one spawns it as a child. The two
// are the same command over a different length of wire, which is the whole
// reason the remote path does not get its own, less-tested implementation.
//
// stdout belongs to the protocol. Every console line is rerouted to stderr
// before anything can log (bun/mcp.ts has the same rule for the same reason):
// one stray byte in a length-prefixed stream desynchronizes it with no way
// back, and the session log keeps a copy either way.
import { createServer, type NativeDeps } from "./server";
import { serverConnection, stdioDuplex } from "./transport";
import { startLogging } from "./log";
import { APP_HOME } from "./workspaces";
import { BUILD_VERSION } from "../shared/version";

// A server has no window: no folder dialog, no pasteboard, no menu bar
// (remote.md §5). The seams are absent rather than stubbed, so the two
// handlers that need one refuse with a reason instead of silently doing
// nothing; remote.md §10 moves them to the client outright.
const HEADLESS: NativeDeps = {};

export async function serve(): Promise<void> {
  // The connection first, because createServer needs somewhere to push before
  // it has finished booting. Requests that arrive during the boot wait in the
  // connection rather than being answered by a half-built server.
  const conn = serverConnection(stdioDuplex(), BUILD_VERSION);
  const server = await createServer({ push: conn.push, native: HEADLESS, client: () => conn.client() });
  conn.serve(server.requests);
  console.error(`[serve] ledge-server ${BUILD_VERSION} on stdio; app home: ${APP_HOME}`);
  // The client hanging up is the shutdown signal, as it is for the MCP server.
  await conn.closed;
  server.shutdown();
}

if (import.meta.main) {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  startLogging();

  const verb = process.argv[2];
  if (verb !== undefined && verb !== "serve") {
    console.error("usage: ledge-server [serve]");
    console.error("The protocol rides stdin and stdout; there is nothing else to run.");
    process.exit(2);
  }

  await serve();
  process.exit(0);
}
