// Which server is being served right now, and how it changes (remote.md §8).
//
// One connection at a time. This module owns that "one" — the mutable pointer
// every request goes through, the boot-time fallback when the chosen server
// will not open, and the five handlers the view drives it with. It is
// deliberately ignorant of HOW a connection is made: bun/index.ts supplies
// `attach`, because building one means either createServer in this process or
// an ssh child, and both of those are the shell's business. What is left here
// is testable without a window, a socket, or an ssh binary.
//
// The router is the point. Everything above it — the webview's RPC, and every
// command in it — holds one handler map for the life of the process and never
// learns that the machine underneath it changed.
import { REQUEST_METHODS, type ConnectionMethod, type RequestHandlers } from "../shared/wire";
import {
  loadConnections,
  LOCAL_CONNECTION,
  LOCAL_ID,
  pinFitsHost,
  probeHostKey,
  saveConnections,
  validateConnection,
  type Connection,
} from "./connections";
import type { ConnectionInfo } from "../shared/rpc-schema";

/** One live connection: the handlers it serves and the way to end it. */
export interface Attached {
  requests: RequestHandlers;
  /** The server's build, from its handshake. Ours, for a server in this
   * process. What the upgrade offer will read (remote.md §11). */
  build: string;
  shutdown(): void;
}

export interface ConnectionManager {
  /** Stable for the life of the process, whatever it is pointed at. */
  requests: RequestHandlers;
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

export function connectionInfo(c: Connection): ConnectionInfo {
  return {
    id: c.id,
    name: c.name,
    destination: c.destination,
    keyPath: c.keyPath,
    pinned: c.hostKey !== "",
    lastReached: c.lastReached,
  };
}

/**
 * Open the configured connection and return the map to serve.
 *
 * Boot never fails over a connection. If the chosen server will not open — the
 * laptop it lives on is asleep, the key was rotated, the address was a typo —
 * this falls back to the local server and remembers why, so the app opens onto
 * this machine's notes with an indicator saying that is what happened. An app
 * that does not open teaches nothing; one that opens on the wrong machine and
 * says so can be fixed from inside itself.
 */
export async function createConnectionManager(deps: {
  attach(conn: Connection): Promise<Attached>;
  now?: () => number;
}): Promise<ConnectionManager> {
  const now = deps.now ?? (() => Date.now());
  let { connections, selected } = await loadConnections();

  const find = (id: string): Connection | null =>
    id === LOCAL_ID ? LOCAL_CONNECTION : (connections.find((c) => c.id === id) ?? null);

  let active: Connection = LOCAL_CONNECTION;
  let live: Attached;
  let error = "";
  let wanted = selected;

  const chosen = find(selected);
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
  if (active.id !== LOCAL_ID) await touch(active.id);

  // Built once from the schema's own list, so a method added there is routed
  // without anyone remembering to add it here. The cast is the same one the
  // transport's dispatch makes: a map keyed by method name cannot be expressed
  // in terms of the per-method parameter types without a lookup type per key.
  const router = Object.fromEntries(
    REQUEST_METHODS.map((m) => [m, (p: unknown) => (live.requests as unknown as Record<string, (p: unknown) => unknown>)[m]!(p)]),
  ) as unknown as RequestHandlers;

  async function touch(id: string): Promise<void> {
    connections = connections.map((c) => (c.id === id ? { ...c, lastReached: now() } : c));
    await persist();
  }

  async function persist(): Promise<void> {
    try {
      await saveConnections(connections, selected);
    } catch (err) {
      // A list that cannot be written costs the NEXT launch its choice, not
      // this session its connection.
      console.error("[connect] could not save the connection list:", reason(err));
    }
  }

  const handlers: Pick<RequestHandlers, ConnectionMethod> = {
    connectionList: async () => ({
      connections: [LOCAL_CONNECTION, ...connections].map(connectionInfo),
      active: active.id,
      wanted,
      error,
      build: live.build,
    }),

    connectionSelect: async ({ id }) => {
      const next = find(id);
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
      if (next.id === LOCAL_ID) await persist();
      else await touch(next.id);
      return { ok: true, error: "" };
    },

    connectionAdd: async ({ name, destination, keyPath, hostKey }) => {
      const refusal = validateConnection({ name, destination, keyPath });
      if (refusal) return { id: "", error: refusal };
      const conn: Connection = {
        id: crypto.randomUUID(),
        name: name.trim(),
        destination: destination.trim(),
        keyPath: keyPath.trim(),
        hostKey: hostKey.trim(),
        lastReached: 0,
      };
      connections = [...connections, conn];
      await persist();
      return { id: conn.id, error: "" };
    },

    connectionUpdate: async ({ id, name, destination, keyPath, hostKey }) => {
      if (id === LOCAL_ID) return { ok: false, error: "This Mac is not a connection you can edit." };
      const before = connections.find((c) => c.id === id);
      if (!before) return { ok: false, error: "There is no such connection." };
      const refusal = validateConnection({ name, destination, keyPath });
      if (refusal) return { ok: false, error: refusal };
      // Null keeps what is pinned; a line replaces it. Either way a pin is a
      // claim about one machine, and carrying one to another address would
      // refuse every later connection with a message about a CHANGED host key
      // — so the caller reads the new machine's fingerprint instead
      // (remote.md §4), and this is what makes forgetting to impossible.
      const pin = hostKey === null ? before.hostKey : hostKey.trim();
      if (!pinFitsHost(pin, destination)) {
        return { ok: false, error: "That pinned key belongs to another host. Check the new host's fingerprint first." };
      }
      const next: Connection = {
        ...before,
        name: name.trim(),
        destination: destination.trim(),
        keyPath: keyPath.trim(),
        hostKey: pin,
      };
      // How the connection is MADE changed, and the wire in front of the user
      // was made the old way. Re-opened before the old one is torn down, like a
      // switch: an edited address that does not answer must cost no more than a
      // typo in the add form does.
      if (id === active.id && (next.destination !== before.destination || next.keyPath !== before.keyPath)) {
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
      } else if (id === active.id) {
        active = next;
      }
      connections = connections.map((c) => (c.id === id ? next : c));
      await persist();
      return { ok: true, error: "" };
    },

    connectionRemove: async ({ id }) => {
      // Both refusals are about leaving the app somewhere it can work from.
      if (id === LOCAL_ID) return { ok: false, error: "This Mac is always here; it cannot be removed." };
      if (id === active.id) return { ok: false, error: "Switch somewhere else before removing this connection." };
      if (!connections.some((c) => c.id === id)) return { ok: false, error: "There is no such connection." };
      connections = connections.filter((c) => c.id !== id);
      if (selected === id) selected = active.id;
      // saveConnections re-renders the known_hosts file from what is left, so
      // removing a connection removes its pin in the same breath.
      await persist();
      return { ok: true, error: "" };
    },

    connectionProbe: async ({ destination }) => {
      const probed = await probeHostKey(destination.trim());
      return "error" in probed ? { hostKey: "", fingerprint: "", keyType: "", error: probed.error } : { ...probed, error: "" };
    },
  };

  return {
    requests: { ...router, ...handlers },
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
