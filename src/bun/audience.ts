// Who a push goes to, once a server has more than one client (remote.md §7).
//
// `bun/server.ts` says WHICH client every push is for and leaves the routing to
// whoever is holding the clients, because who is a fact about a session or a
// run and only the server knows it, while where a client actually is is a fact
// about connections and only the holder knows that. There are two holders:
// bun/daemon.ts, which has a socket per client, and bun/index.ts, which has a
// window per client (§8a). This is the part they do identically.
import { PUSH_MESSAGES, type ServerPush } from "../shared/wire";
import type { Audience } from "./server";

/**
 * A push object that writes to whoever `pick` names AT THE MOMENT it is called.
 *
 * That indirection is the whole reason this is not just a client's own push
 * object: a server outlives every connection and every window it was built
 * with, so nothing may be captured when createServer runs.
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
 * per client — a socket for the daemon, a window for the shell.
 *
 * One object per audience rather than one per push. `to` is called on the
 * hottest path the server has — a shell's bytes, per drawer, per coalescing
 * window — and building eight closures to throw away each time is a cost with
 * nothing to show for it. A memoized entry holds the id and nothing else, so a
 * client that leaves leaves eight dead functions rather than a connection.
 *
 * A push addressed to a client that is not here is dropped, which is the
 * ordinary case rather than an edge: the watcher fires whenever a file moves, a
 * run keeps producing output, and both go on happily while nobody is attached.
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
  };
}
