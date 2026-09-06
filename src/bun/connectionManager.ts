// Which server one window is being served by, and how it changes (remote.md
// §8, §8a).
//
// One connection at a time, and this module owns which one: every request from
// the window is routed through it, boot falls back to the local server when the
// chosen one will not open, and the view moves it with the connection handlers
// below. One manager per window, over one shared bun/connectionStore.ts,
// because the list belongs to the app and the selection to the window (§8a).
//
// How a connection is made is not here. `attach` comes from bun/index.ts, the
// shell that owns the windows and the child processes: building a connection
// means either createServer in this process or an ssh child. What is left here
// runs in a test with no window, no socket, and no ssh binary.
//
// Above the router, the webview's RPC and every command in it hold one handler
// map for the life of the window. A switch replaces the connection under the
// router, and that map stays as it is.
import { REQUEST_METHODS, type ConnectionMethod, type RequestHandlers } from "../shared/wire";
import { LOCAL_CONNECTION, LOCAL_ID, type Connection } from "./connections";
import { connectionInfo, createConnectionStore, type ConnectionStore } from "./connectionStore";

/** One live connection: the handlers it serves and the way to end it. */
export interface Attached {
  requests: RequestHandlers;
  /** Ask this connection's wire to try now (shared/transport.ts `recheck`).
   * A no-op for a server in this process, which has no wire to ask. */
  recheck(): void;
  /** The server's build, from its handshake. This app's own build for a server
   * in this process. The upgrade offer will read it (remote.md §11). */
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
   * Recorded, not acted on: dialling again from here would rebuild the loop
   * the transport stopped. `connectionSelect` reads the record. It returns
   * early when the connection asked for is already the one being served and
   * `error` is empty, and it attaches afresh once this has set `error`.
   */
  lost(id: string, detail: string): void;
  /**
   * The wire to `id` came back on its own, which it can: the transport keeps
   * dialling after its ladder is spent (shared/transport.ts RETRY_EVERY_MS).
   *
   * Clears what `lost` recorded. That record means "this connection needs
   * re-attaching". Leaving it set after a recovery would make choosing the
   * same connection tear a working session down and build it again. That
   * reloads the page and every buffer on it.
   */
  restored(id: string): void;
  shutdown(): void;
}

// The handlers below are CONNECTION_METHODS from shared/wire.ts, listed there
// with the rest of what never becomes a frame. This module implements them for
// the Mac, and mainview/lib/nativeBridge.ts implements them for the phone
// (ios.md §2). The list is in shared/ because two clients implement it.

export { connectionInfo } from "./connectionStore";

/**
 * Open one window's connection and return the map to serve.
 *
 * Boot never fails over a connection. When the chosen server will not open (a
 * sleeping laptop, a rotated key, a typo in the address) this attaches the
 * local server instead and records the reason. The window opens onto this
 * machine's notes with an indicator saying so, and the connection can be fixed
 * from inside the app. Refusing to open would leave nothing to fix it with
 * (remote.md §8). The fallback is per window: the other windows keep the
 * connections they have (§8a).
 */
export async function createConnectionManager(deps: {
  attach(conn: Connection): Promise<Attached>;
  /** The app's one list. A private one is built when none is supplied, which is
   * what a single-window process and every test use. */
  store?: ConnectionStore;
  /** Where this window should open. bun/index.ts passes the connection the
   * window list holds for this window (§8a). A caller that passes nothing,
   * which is most of the tests here, gets the store's `launchSelection`
   * (connectionStore.ts). */
  want?: string;
  /** Told whenever this window's connection changes, so the shell can record it
   * in the window list. The next launch reads this window's server from that
   * list, not from `connections.json` (§8a). */
  onSelect?(id: string): void;
  /** Told what this window's connection is called, whenever that answer
   * changes: a switch, a boot that fell back, or a rename of the connection
   * being served. The shell puts the name in the window's title. Once there is
   * more than one window, the title is the only label that says which machine a
   * window is showing (§8a). Separate from `onSelect` because a rename moves no
   * window and must not rewrite the window list. */
  onName?(name: string): void;
  now?: () => number;
}): Promise<ConnectionManager> {
  // Declared before the store, which closes over it. A private store's "what is
  // in use" is this one window. The shell's shared store is told about every
  // window instead (bun/index.ts).
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
  // Reports the connection's name before the window exists. The shell holds
  // the name and gives it to the window it builds next (bun/index.ts), so no
  // window is ever titled for a machine it is not on.
  deps.onName?.(active.name);
  if (active.id !== LOCAL_ID) await store.touch(active.id);

  // Built once from REQUEST_METHODS, so a method added to the schema is routed
  // without anyone adding it here. shared/transport.ts builds its request
  // client with the same cast: a map keyed by method name cannot be expressed
  // in terms of the per-method parameter types without a lookup type per key.
  const router = Object.fromEntries(
    REQUEST_METHODS.map((m) => [m, (p: unknown) => (live.requests as unknown as Record<string, (p: unknown) => unknown>)[m]!(p)]),
  ) as unknown as RequestHandlers;

  // Whether another window is pointed at `id` right now. The store tracks every
  // window's connection, this one's included, so this window's own hold does
  // not count.
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
      // Open the new connection before tearing the old one down. A destination
      // that does not answer then costs nothing: the session in front of the
      // user keeps running, and the reason comes back as an error string.
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
      deps.onName?.(next.name);
      if (next.id !== LOCAL_ID) await store.touch(next.id);
      return { ok: true, error: "" };
    },

    // Not a question for the server: there may be no server to ask. This tells
    // the window's own wire to stop waiting for its next attempt and try now.
    // What came of it arrives on `connectionState`, the way every other link
    // change does.
    connectionReconnect: async () => {
      live.recheck();
      return { ok: true };
    },

    connectionAdd: async (fields) => store.add(fields),

    connectionUpdate: async (fields) => {
      const { conn: next, error: refusal } = await store.reviewUpdate(fields);
      if (!next) return { ok: false, error: refusal };
      const before = store.find(fields.id);
      // The credential changed when `auth` changed, or when the form sent a new
      // password. A null password means the form did not ask for one, which is
      // what a rename sends (rpc-schema.ts `connectionUpdate`).
      const recredentialed = !before || next.auth !== before.auth || fields.password !== null;
      const readdressed =
        !before ||
        next.destination !== before.destination ||
        next.port !== before.port ||
        next.keyPath !== before.keyPath ||
        recredentialed;
      // Refuse the edit: how the connection is made changed, and another
      // window's wire was built the old way. This window re-opens its own
      // below. Another window's cannot be re-opened from here, so it would
      // keep talking to the old machine while the row names the new one, the
      // lie the indicator exists to prevent (§8a). A rename changes nothing
      // about how a connection is made and is allowed.
      if (readdressed && heldElsewhere(fields.id)) {
        return { ok: false, error: "Another window is on that connection. Switch it somewhere else before changing how it connects." };
      }
      // Store the credential before dialling, because the dial is what proves a
      // password. ssh's askpass helper reads it from the keychain (secrets.ts),
      // so the new value has to be stored for the attempt below to test it.
      // Every error path after this restores the old value.
      const swap = await store.swapPassword(fields.id, fields.auth, fields.password);
      if (swap.error) return { ok: false, error: swap.error };
      if (readdressed && fields.id === active.id) {
        // Opened before the old one is torn down, as connectionSelect does it.
        // An edited address that does not answer then costs no more than a typo
        // in the add form does.
        let opened: Attached;
        try {
          opened = await deps.attach(next);
        } catch (err) {
          await swap.restore();
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
      // A rename of the connection this window is on. Nothing about the wire
      // changed, but the window's title still holds the old name.
      if (fields.id === active.id) deps.onName?.(active.name);
      await store.write(next);
      return { ok: true, error: "" };
    },

    connectionRemove: async ({ id }) => store.remove(id),

    connectionProbe: async ({ destination, port }) => store.probe(destination, port),
  };

  return {
    requests: { ...router, ...handlers },
    active: () => active.id,
    lost: (id, detail) => {
      // Checked by id: a connection torn down on the way to another one can
      // report its own end after the switch, and that report must not mark the
      // new connection dead.
      if (id === active.id) error = detail;
    },
    restored: (id) => {
      // Checked by id for the same reason, from the other side: a dead
      // connection recovering late must not clear the reason recorded for a
      // different one.
      if (id === active.id) error = "";
    },
    shutdown: () => live.shutdown(),
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Names a connection for the log line that says it could not be reached. A
// connection deleted out from under the selection has only its id left.
function labelOf(conn: Connection | null, id: string): string {
  return conn ? conn.name : id;
}
