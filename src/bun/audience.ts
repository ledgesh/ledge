// Who a push goes to, once a server has more than one client (remote.md §7).
// bun/server.ts names which client each push is for and leaves the routing to
// whoever holds the clients. Which client is a fact about a session or a run,
// and only the server knows it. How to reach that client is a fact about
// connections, and only the holder knows it. There are two holders:
// bun/daemon.ts holds a socket per client, bun/index.ts a window per client
// (remote.md §8a). This module is the part they do identically.
import { PUSH_MESSAGES, type ServerPush } from "../shared/wire";
import type { Audience } from "./server";

/**
 * A push object that writes to whoever `pick` names at the moment it is called.
 *
 * fanout takes a picker rather than a client's own push object because a
 * server outlives every connection and every window it was built with. Nothing
 * may be captured when createServer runs.
 */
export function fanout(pick: () => Iterable<ServerPush>): ServerPush {
  return Object.fromEntries(
    PUSH_MESSAGES.map((m) => [
      m,
      (p: unknown) => {
        for (const one of pick()) (one as unknown as Record<string, (p: unknown) => void>)[m]!(p);
      },
    ]),
  ) as unknown as ServerPush;
}

/**
 * Both audiences over one live map of client id to whatever the holder keeps
 * per client: a socket for the daemon, a window for the shell.
 *
 * `to` runs on the hot path for a shell's bytes (per drawer, per drain tick),
 * so it memoizes each client's push object. The memo captures the client id
 * and nothing else, so a client that goes away leaves dead functions rather
 * than its socket or window.
 *
 * A push addressed to a client that is not here is dropped (remote.md §7).
 * That is the ordinary case: a watcher fires whenever a file moves, and a run
 * keeps producing output, even when nobody is attached. `has` is here so the
 * one caller that cares can ask first (bun/server.ts sendRunEvent).
 */
export function audienceOf<T>(clients: ReadonlyMap<string, T>, pushOf: (held: T) => ServerPush): Audience {
  const addressed = new Map<string, ServerPush>();
  return {
    all: fanout(function* () {
      for (const held of clients.values()) yield pushOf(held);
    }),
    to(client) {
      let one = addressed.get(client);
      if (!one) {
        one = fanout(function* () {
          const held = clients.get(client);
          if (held !== undefined) yield pushOf(held);
        });
        addressed.set(client, one);
      }
      return one;
    },
    has: (client) => clients.has(client),
  };
}
