// The list of servers this app can reach, and the file it lives in.
//
// Shared by every window (remote.md §8a). A machine you have paired with is a
// fact about this Mac rather than about one of its windows, so the records, the
// pins and the client ids filed against them are process state, and exactly one
// thing owns `connections.json`. What is NOT here is which connection a window
// points at: that is the window's, and bun/connectionManager.ts is one per
// window.
//
// The split is the whole reason this module exists. Two windows writing one
// selection would mean the last one to switch decided where the next launch
// opened; two windows each holding their own copy of the LIST would mean a
// connection added in one is invisible in the other until it is restarted.
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
import { forgetClientId } from "./clientHome";
import type { ConnectionInfo } from "../shared/rpc-schema";

export interface ConnectionStore {
  /** Every connection, the local server first. */
  all(): Connection[];
  /** One by id, the local server included, or null. */
  find(id: string): Connection | null;
  /**
   * Where a window with nothing else to go on opens.
   *
   * The stored `selected` key, which stops being written once there is a window
   * list to write instead (bun/windowFrame.ts). It is read for exactly two
   * cases: an install upgrading across §8a, which has a selection and no window
   * list, and a client home whose window list could not be read.
   */
  launchSelection(): string;
  /** Record that a connection answered, for the list's "last reached". */
  touch(id: string): Promise<void>;
  add(fields: { name: string; destination: string; keyPath: string; hostKey: string }): Promise<{ id: string; error: string }>;
  /**
   * An edit, checked but NOT stored: the record it would become, or the reason
   * it may not.
   *
   * Two steps because the caller holds a wire that was built the old way, and
   * re-opening it has to happen before anything is committed — an address that
   * does not answer must cost no more than a typo in the add form does. `write`
   * below is the other half, and nothing is persisted until it runs.
   */
  reviewUpdate(fields: {
    id: string;
    name: string;
    destination: string;
    keyPath: string;
    hostKey: string | null;
  }): { conn: Connection | null; error: string };
  /** Store an edit that `reviewUpdate` passed and the caller has committed to. */
  write(conn: Connection): Promise<void>;
  remove(id: string): Promise<{ ok: boolean; error: string }>;
  probe(destination: string): Promise<{ hostKey: string; fingerprint: string; keyType: string; error: string }>;
  /**
   * Which connections a window is pointed at right now, so `remove` can refuse
   * one that is in use by ANY window rather than only by the one asking.
   *
   * A function rather than a set this module maintains: the windows are the
   * shell's, they come and go with AppKit, and a store that tracked them would
   * be tracking something it cannot see.
   */
  inUse(): Iterable<string>;
}

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

export async function createConnectionStore(deps: {
  now?: () => number;
  /** Defaults to nothing in use, which is what every test and the first moment
   * of boot both want. */
  inUse?: () => Iterable<string>;
} = {}): Promise<ConnectionStore> {
  const now = deps.now ?? (() => Date.now());
  const inUse = deps.inUse ?? (() => []);
  const loaded = await loadConnections();
  let connections = loaded.connections;
  // Loaded once and written back unchanged. The window list is the authority on
  // where a window opens; keeping this key inert rather than deleting it means
  // an install that downgrades, or one whose window list is lost, still lands
  // on the server it was last using instead of on this Mac.
  const selected = loaded.selected;

  async function persist(): Promise<void> {
    try {
      await saveConnections(connections, selected);
    } catch (err) {
      // A list that cannot be written costs the NEXT launch its records, not
      // this session its connections.
      console.error("[connect] could not save the connection list:", reason(err));
    }
  }

  return {
    all: () => [LOCAL_CONNECTION, ...connections],
    find: (id) => (id === LOCAL_ID ? LOCAL_CONNECTION : (connections.find((c) => c.id === id) ?? null)),
    launchSelection: () => selected,
    inUse,

    touch: async (id) => {
      connections = connections.map((c) => (c.id === id ? { ...c, lastReached: now() } : c));
      await persist();
    },

    add: async ({ name, destination, keyPath, hostKey }) => {
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

    reviewUpdate: ({ id, name, destination, keyPath, hostKey }) => {
      if (id === LOCAL_ID) return { conn: null, error: "This Mac is not a connection you can edit." };
      const before = connections.find((c) => c.id === id);
      if (!before) return { conn: null, error: "There is no such connection." };
      const refusal = validateConnection({ name, destination, keyPath });
      if (refusal) return { conn: null, error: refusal };
      // Null keeps what is pinned; a line replaces it. Either way a pin is a
      // claim about one machine, and carrying one to another address would
      // refuse every later connection with a message about a CHANGED host key
      // — so the caller reads the new machine's fingerprint instead
      // (remote.md §4), and this is what makes forgetting to impossible.
      const pin = hostKey === null ? before.hostKey : hostKey.trim();
      if (!pinFitsHost(pin, destination)) {
        return { conn: null, error: "That pinned key belongs to another host. Check the new host's fingerprint first." };
      }
      const next: Connection = {
        ...before,
        name: name.trim(),
        destination: destination.trim(),
        keyPath: keyPath.trim(),
        hostKey: pin,
      };
      return { conn: next, error: "" };
    },

    write: async (conn) => {
      connections = connections.map((c) => (c.id === conn.id ? conn : c));
      await persist();
    },

    remove: async (id) => {
      // All three refusals are about leaving the app somewhere it can work from.
      if (id === LOCAL_ID) return { ok: false, error: "This Mac is always here; it cannot be removed." };
      for (const held of inUse()) {
        if (held === id) return { ok: false, error: "Switch somewhere else before removing this connection." };
      }
      if (!connections.some((c) => c.id === id)) return { ok: false, error: "There is no such connection." };
      connections = connections.filter((c) => c.id !== id);
      // saveConnections re-renders the known_hosts file from what is left, so
      // removing a connection removes its pin in the same breath — and the id
      // this client was known by there goes with it, which is what keeps the
      // map bounded by the list (remote.md §8a).
      await persist();
      await forgetClientId(id);
      return { ok: true, error: "" };
    },

    probe: async (destination) => {
      const probed = await probeHostKey(destination.trim());
      return "error" in probed ? { hostKey: "", fingerprint: "", keyType: "", error: probed.error } : { ...probed, error: "" };
    },
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
