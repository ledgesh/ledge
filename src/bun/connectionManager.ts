// Which server one WINDOW is being served by, and how it changes (remote.md
// §8, §8a).
//
// One connection at a time. This module owns that "one" — the mutable pointer
// every request from that window goes through, the boot-time fallback when the
// chosen server will not open, and the six handlers the view drives it with. It
// is deliberately ignorant of HOW a connection is made: bun/index.ts supplies
// `attach`, because building one means either createServer in this process or
// an ssh child, and both of those are the shell's business. What is left here
// is testable without a window, a socket, or an ssh binary.
//
// One of these per window, over one shared bun/connectionStore.ts. The LIST is
// the app's and the SELECTION is the window's (§8a): two windows writing one
// selection would mean the last one to switch decided where the next launch
// opened, and two windows each holding a copy of the list would mean a
// connection added in one is invisible in the other.
//
// The router is the point. Everything above it — the webview's RPC, and every
// command in it — holds one handler map for the life of the window and never
// learns that the machine underneath it changed.
import { REQUEST_METHODS, type ConnectionMethod, type RequestHandlers } from "../shared/wire";
import { LOCAL_CONNECTION, LOCAL_ID, type Connection } from "./connections";
import { connectionInfo, createConnectionStore, type ConnectionStore } from "./connectionStore";

/** One live connection: the handlers it serves and the way to end it. */
export interface Attached {
  requests: RequestHandlers;
  /** The server's build, from its handshake. Ours, for a server in this
   * process. What the upgrade offer will read (remote.md §11). */
  build: string;
  shutdown(): void;
}

export interface ConnectionManager {
  /** Stable for the life of the window, whatever it is pointed at. */
  requests: RequestHandlers;
  /** The connection being served right now, for the shell's window list and for
   * the store's "is anything using this" refusals. */
  active(): string;
  /**
   * The wire to `id` gave up for good: its ladder ran out, or the server said
   * goodbye (shared/transport.ts).
   *
   * Recorded rather than acted on, because there is nothing to act on — a
   * transport that stopped stopped on purpose, and re-dialling behind the
   * user's back is the loop it stopped to avoid. What this buys is the
   * documented recovery: choosing the same connection again is normally a
   * no-op, and it has to attach afresh once the one being pointed at is dead.
   */
  lost(id: string, detail: string): void;
  shutdown(): void;
}

// CONNECTION_METHODS is shared/wire.ts's, with the rest of what never becomes
// a frame. This module is the Mac's implementation of it; the phone has its
// own and the list has to outlive both (ios.md §2).

export { connectionInfo } from "./connectionStore";

/**
 * Open one window's connection and return the map to serve.
 *
 * Boot never fails over a connection. If the chosen server will not open — the
 * laptop it lives on is asleep, the key was rotated, the address was a typo —
 * this falls back to the local server and remembers why, so the window opens
 * onto this machine's notes with an indicator saying that is what happened. An
 * app that does not open teaches nothing; one that opens on the wrong machine
 * and says so can be fixed from inside itself. It applies per window: a server
 * that will not open costs that window a fallback and costs the others nothing
 * (§8a).
 */
export async function createConnectionManager(deps: {
  attach(conn: Connection): Promise<Attached>;
  /** The app's one list. A private one is built when none is supplied, which is
   * what a single-window process and every test both want. */
  store?: ConnectionStore;
  /** Where this window should open. The store's launch selection by default,
   * which is the first window's answer and the migration path's. */
  want?: string;
  /** Told whenever this window's connection changes, so the shell can record it
   * in the window list — that list is where the next launch reads it from, not
   * `connections.json` (§8a). */
  onSelect?(id: string): void;
  now?: () => number;
}): Promise<ConnectionManager> {
  // Declared before the store, which closes over it: a private store's "what is
  // in use" is this one window, and the shell's shared one is told about every
  // window (bun/index.ts).
  let active: Connection = LOCAL_CONNECTION;
  const store = deps.store ?? (await createConnectionStore({ now: deps.now, inUse: () => [active.id] }));
  let selected = deps.want ?? store.launchSelection();

  let live: Attached;
  let error = "";
  let wanted = selected;

  const chosen = store.find(selected);
  try {
    if (!chosen) throw new Error("that connection is gone");
    live = await deps.attach(chosen);
    active = chosen;
  } catch (err) {
    error = reason(err);
    if (selected !== LOCAL_ID) console.error(`[connect] ${labelOf(chosen, selected)}: ${error}`);
    live = await deps.attach(LOCAL_CONNECTION);
    active = LOCAL_CONNECTION;
  }
  selected = active.id;
  if (active.id !== LOCAL_ID) await store.touch(active.id);

  // Built once from the schema's own list, so a method added there is routed
  // without anyone remembering to add it here. The cast is the same one the
  // transport's dispatch makes: a map keyed by method name cannot be expressed
  // in terms of the per-method parameter types without a lookup type per key.
  const router = Object.fromEntries(
    REQUEST_METHODS.map((m) => [m, (p: unknown) => (live.requests as unknown as Record<string, (p: unknown) => unknown>)[m]!(p)]),
  ) as unknown as RequestHandlers;

  // Whether another window is pointed at `id` right now. The store tracks the
  // set; what this adds is "another", since a window asking about the
  // connection it is itself holding is asking about itself.
  function heldElsewhere(id: string): boolean {
    let seen = 0;
    for (const held of store.inUse()) if (held === id) seen += 1;
    return seen > (active.id === id ? 1 : 0);
  }

  const handlers: Pick<RequestHandlers, ConnectionMethod> = {
    connectionList: async () => ({
      connections: store.all().map(connectionInfo),
      active: active.id,
      wanted,
      error,
      build: live.build,
    }),

    connectionSelect: async ({ id }) => {
      const next = store.find(id);
      if (!next) return { ok: false, error: "There is no such connection." };
      if (next.id === active.id && !error) return { ok: true, error: "" };
      // The new one is opened BEFORE the old one is torn down. A destination
      // that does not answer must cost nothing: the session in front of the
      // user keeps running and the reason arrives as a sentence.
      let opened: Attached;
      try {
        opened = await deps.attach(next);
      } catch (err) {
        return { ok: false, error: `Could not reach ${next.name}: ${reason(err)}` };
      }
      const previous = live;
      live = opened;
      active = next;
      selected = next.id;
      wanted = next.id;
      error = "";
      previous.shutdown();
      deps.onSelect?.(next.id);
      if (next.id !== LOCAL_ID) await store.touch(next.id);
      return { ok: true, error: "" };
    },

    connectionAdd: async (fields) => store.add(fields),

    connectionUpdate: async (fields) => {
      const { conn: next, error: refusal } = store.reviewUpdate(fields);
      if (!next) return { ok: false, error: refusal };
      const before = store.find(fields.id);
      const readdressed = !before || next.destination !== before.destination || next.keyPath !== before.keyPath;
      // How the connection is MADE changed, and some window's wire was made the
      // old way. This one re-opens its own; another window's cannot be re-opened
      // from here, and leaving it pointed at the old machine while the row names
      // the new one is the lie the indicator exists to prevent — so the edit
      // waits (§8a). A rename changes nothing about how a connection is made and
      // is never refused.
      if (readdressed && heldElsewhere(fields.id)) {
        return { ok: false, error: "Another window is on that connection. Switch it somewhere else before changing the address." };
      }
      if (readdressed && fields.id === active.id) {
        // Re-opened before the old one is torn down, like a switch: an edited
        // address that does not answer must cost no more than a typo does.
        let opened: Attached;
        try {
          opened = await deps.attach(next);
        } catch (err) {
          return { ok: false, error: `Could not reach ${next.name}: ${reason(err)}` };
        }
        const previous = live;
        live = opened;
        active = next;
        error = "";
        previous.shutdown();
      } else if (fields.id === active.id) {
        active = next;
      }
      await store.write(next);
      return { ok: true, error: "" };
    },

    connectionRemove: async ({ id }) => store.remove(id),

    connectionProbe: async ({ destination }) => store.probe(destination),
  };

  return {
    requests: { ...router, ...handlers },
    active: () => active.id,
    lost: (id, detail) => {
      // By id, because the connection being torn down on the way to another
      // one can report its own end after the switch has already happened, and
      // marking the new connection dead would be worse than saying nothing.
      if (id === active.id) error = detail;
    },
    shutdown: () => live.shutdown(),
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A connection that has been deleted out from under the selection still needs
// naming in the log line that says it could not be reached.
function labelOf(conn: Connection | null, id: string): string {
  return conn ? conn.name : id;
}
