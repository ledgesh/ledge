// The list of servers this app can reach, and the file it lives in.
//
// One store for the whole process, shared by every window (remote.md §8a).
// The records, the pins and the client ids filed against them are facts about
// this Mac. Writes go through `saveConnections` (bun/connections.ts), and
// outside tests this module is its only caller.
//
// Which connection a window points at is not here. Each window has its own
// bun/connectionManager.ts, and the pointer lives there. Two windows writing
// one selection would let the last one to switch decide where the next launch
// opened. Two windows each holding a copy of the list would hide a connection
// added in one from the other.
import {
  loadConnections,
  LOCAL_CONNECTION,
  LOCAL_ID,
  pinFitsHost,
  probeHostKey,
  saveConnections,
  validateConnection,
  validatePassword,
  type AuthMode,
  type Connection,
} from "./connections";
import { forgetClientId } from "./clientHome";
import { forgetPassword, hasPassword, storePassword, swapPassword as swapStoredPassword } from "./secrets";
import type { ConnectionInfo } from "../shared/rpc-schema";

export interface ConnectionStore {
  /** Every connection, the local server first. */
  all(): Connection[];
  /** One by id, the local server included, or null. */
  find(id: string): Connection | null;
  /**
   * Where a window with nothing else to go on opens.
   *
   * Returns the stored `selected` key, which the window list replaced as the
   * record of where a window opens (bun/windowFrame.ts). Two conditions fall
   * back to it. An install upgrading across remote.md §8a has a selection but
   * no window list. A client home's window list may fail to read.
   */
  launchSelection(): string;
  /** Record that a connection answered, for the list's "last reached". */
  touch(id: string): Promise<void>;
  add(fields: {
    name: string;
    destination: string;
    port: number;
    keyPath: string;
    auth: AuthMode;
    /** The plaintext password, which goes to the keychain and nowhere else.
     * Ignored unless `auth` is "password". */
    password: string;
    hostKey: string;
  }): Promise<{ id: string; error: string }>;
  /**
   * Check an edit without storing it: returns the record it would become, or
   * the reason it may not.
   *
   * Two steps so the caller can re-open its wire in between.
   * bun/connectionManager.ts re-opens when how the connection is made changed
   * and its window is on that connection. An address that does not answer then
   * costs no more than a typo in the add form does. `write` below stores the
   * record, and nothing in the list changes until it runs.
   */
  reviewUpdate(fields: {
    id: string;
    name: string;
    destination: string;
    port: number;
    keyPath: string;
    auth: AuthMode;
    /** Null keeps the stored password, a string replaces it. Refused as null
     * when the connection is switching to the password door and has none. */
    password: string | null;
    hostKey: string | null;
  }): Promise<{ conn: Connection | null; error: string }>;
  /**
   * Store the credential where the next dial will look for it, and return a
   * `restore` that undoes the store.
   *
   * Separate from `write` because the caller re-opens the wire between the
   * two. The dial is what proves a password, so the new one has to be in the
   * keychain before ssh runs. `restore` puts the old credential back when that
   * dial fails, leaving the connection as it was.
   *
   * Restoring means holding the old password in memory (bun/secrets.ts
   * `swapPassword`): the user's own secret, in the user's own process, for as
   * long as one ssh takes to fail. Without it, an edit that mistyped a
   * password would destroy the working one while reporting the failure.
   */
  swapPassword(id: string, auth: AuthMode, password: string | null): Promise<{ error: string; restore: () => Promise<void> }>;
  /** Store an edit that `reviewUpdate` passed and the caller has committed to. */
  write(conn: Connection): Promise<void>;
  remove(id: string): Promise<{ ok: boolean; error: string }>;
  probe(destination: string, port: number): Promise<{ hostKey: string; fingerprint: string; keyType: string; error: string }>;
  /**
   * Which connections the windows are pointed at right now, so `remove` can
   * refuse one that any window is using rather than only the one asking.
   *
   * A function rather than a set this module keeps: the windows belong to the
   * shell and come and go with AppKit, so the store cannot see them.
   */
  inUse(): Iterable<string>;
}

/**
 * The keychain, as four functions (bun/secrets.ts).
 *
 * A seam rather than a direct import, so tests can exercise the password door
 * without writing to the login keychain (testing.md §4). The keychain itself
 * is a native seam, proved by the live probe (testing.md §6). The tests that
 * stub it (bun/connectionManager.fs.test.ts `fakeSecrets`) check the order:
 * which of the write, the dial and the record happens first, and what is put
 * back when one of them fails.
 */
export interface Secrets {
  store(id: string, password: string): Promise<{ ok: boolean; error: string }>;
  has(id: string): Promise<boolean>;
  forget(id: string): Promise<void>;
  swap(id: string, next: string | null): Promise<{ error: string; restore: () => Promise<void> }>;
}

const REAL_SECRETS: Secrets = {
  store: storePassword,
  has: hasPassword,
  forget: forgetPassword,
  swap: swapStoredPassword,
};

export function connectionInfo(c: Connection): ConnectionInfo {
  return {
    id: c.id,
    name: c.name,
    destination: c.destination,
    port: c.port,
    keyPath: c.keyPath,
    auth: c.auth,
    pinned: c.hostKey !== "",
    lastReached: c.lastReached,
  };
}

export async function createConnectionStore(deps: {
  now?: () => number;
  /** Which connections the windows hold. Defaults to nothing in use; the app
   * passes a real one (bun/index.ts, bun/connectionManager.ts). */
  inUse?: () => Iterable<string>;
  /** Defaults to the real keychain. */
  secrets?: Secrets;
} = {}): Promise<ConnectionStore> {
  const now = deps.now ?? (() => Date.now());
  const inUse = deps.inUse ?? (() => []);
  const secrets = deps.secrets ?? REAL_SECRETS;
  const loaded = await loadConnections();
  let connections = loaded.connections;
  // Loaded once and written back unchanged. The window list is the authority
  // on where a window opens (bun/windowFrame.ts). The key stays anyway, for an
  // install that downgrades or one whose window list is lost. Either still
  // opens on the server it was last using, not on this Mac.
  const selected = loaded.selected;

  async function persist(): Promise<void> {
    try {
      await saveConnections(connections, selected);
    } catch (err) {
      // A list that cannot be written costs the next launch its records. This
      // session keeps the connections it has.
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

    add: async ({ name, destination, port, keyPath, auth, password, hostKey }) => {
      const refusal = validateConnection({ name, destination, keyPath, port });
      if (refusal) return { id: "", error: refusal };
      if (auth === "password") {
        const unusable = validatePassword(password);
        if (unusable) return { id: "", error: unusable };
      }
      const conn: Connection = {
        id: crypto.randomUUID(),
        name: name.trim(),
        destination: destination.trim(),
        port,
        // No key is offered on the password door (`PubkeyAuthentication=no`,
        // bun/connections.ts), so a path left behind in the form is dropped.
        // Storing it would leave a field with no effect, which a later reader
        // would have to explain.
        keyPath: auth === "password" ? "" : keyPath.trim(),
        auth,
        hostKey: hostKey.trim(),
        lastReached: 0,
      };
      // The secret goes in before the record. A record naming a password door
      // with no password behind it can only fail, and it would fail with ssh's
      // error rather than with the keychain's.
      if (auth === "password") {
        const stored = await secrets.store(conn.id, password);
        if (!stored.ok) return { id: "", error: stored.error };
      }
      connections = [...connections, conn];
      await persist();
      return { id: conn.id, error: "" };
    },

    reviewUpdate: async ({ id, name, destination, port, keyPath, auth, password, hostKey }) => {
      if (id === LOCAL_ID) return { conn: null, error: "This Mac is not a connection you can edit." };
      const before = connections.find((c) => c.id === id);
      if (!before) return { conn: null, error: "There is no such connection." };
      const refusal = validateConnection({ name, destination, keyPath, port });
      if (refusal) return { conn: null, error: refusal };
      if (auth === "password") {
        // Null means "keep what is stored", which is only an answer when
        // something is stored. A connection moved onto the password door with
        // nothing behind it would dial, find no secret, and be refused by the
        // far end for a reason that is on this machine.
        if (password === null) {
          if (!(await secrets.has(id))) return { conn: null, error: "That connection has no password stored. Enter one." };
        } else {
          const unusable = validatePassword(password);
          if (unusable) return { conn: null, error: unusable };
        }
      }
      // Null keeps what is pinned, a line replaces it. A pin is a claim about
      // one machine, so carrying one to another address would refuse every
      // later connection with a changed-host-key message. The check below
      // refuses the edit instead and asks for the new host's fingerprint, so a
      // stale pin cannot travel to a new address (remote.md §4).
      const pin = hostKey === null ? before.hostKey : hostKey.trim();
      // The port is part of the claim: a pin is indexed by `[host]:port` in
      // known_hosts, so moving a connection to a different port on the same
      // machine invalidates it exactly as moving it to another machine does.
      if (!pinFitsHost(pin, destination, port)) {
        return { conn: null, error: "That pinned key belongs to another host. Check the new host's fingerprint first." };
      }
      const next: Connection = {
        ...before,
        name: name.trim(),
        destination: destination.trim(),
        port,
        keyPath: auth === "password" ? "" : keyPath.trim(),
        auth,
        hostKey: pin,
      };
      return { conn: next, error: "" };
    },

    swapPassword: async (id, auth, password) => {
      const before = connections.find((c) => c.id === id);
      // There is nothing to swap in two cases. A connection that was on the
      // key door and stays there has no secret to move. One on the password
      // door whose form did not ask for a new password keeps the one it has.
      // Neither needs a keychain call.
      if (auth === "key" && before?.auth === "key") return NOTHING_SWAPPED;
      if (auth === "password" && password === null) return NOTHING_SWAPPED;
      return secrets.swap(id, auth === "password" ? password : null);
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
      const gone = connections.find((c) => c.id === id);
      if (!gone) return { ok: false, error: "There is no such connection." };
      connections = connections.filter((c) => c.id !== id);
      // saveConnections re-renders the known_hosts file from what is left, so
      // removing a connection removes its pin too. forgetClientId then drops
      // the client id filed against it, which keeps that map bounded by the
      // list (remote.md §8a).
      await persist();
      await forgetClientId(id);
      // Its password goes for the same reason as the pin: a credential that
      // outlived the connection it belonged to is one nothing in the app can
      // show, edit, or delete. Only a password-door record stored one, so
      // removing a key-door connection makes no keychain call at all.
      if (gone.auth === "password") await secrets.forget(id);
      return { ok: true, error: "" };
    },

    probe: async (destination, port) => {
      const probed = await probeHostKey(destination.trim(), port);
      return "error" in probed ? { hostKey: "", fingerprint: "", keyType: "", error: probed.error } : { ...probed, error: "" };
    },
  };
}

/** The result of a swap that moved nothing: no error, and a `restore` that
 * does nothing. */
const NOTHING_SWAPPED = { error: "", restore: async (): Promise<void> => {} };

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
