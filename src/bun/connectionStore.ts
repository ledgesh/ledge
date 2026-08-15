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
   * The stored `selected` key, which stops being written once there is a window
   * list to write instead (bun/windowFrame.ts). It is read for exactly two
   * cases: an install upgrading across §8a, which has a selection and no window
   * list, and a client home whose window list could not be read.
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
    /** The plaintext, on its way to the keychain and nowhere else. Ignored
     * unless `auth` is "password". */
    password: string;
    hostKey: string;
  }): Promise<{ id: string; error: string }>;
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
    port: number;
    keyPath: string;
    auth: AuthMode;
    /** Null keeps the stored password, a string replaces it. Refused as null
     * when the connection is switching to the password door and has none. */
    password: string | null;
    hostKey: string | null;
  }): Promise<{ conn: Connection | null; error: string }>;
  /**
   * Put the credential where the next dial will look for it, and hand back the
   * way to put it back.
   *
   * The caller re-opens the wire between the two, so this cannot be folded into
   * `write`: the dial is what PROVES a password, and proving it means the new
   * one has to be in the keychain before ssh runs. A dial that then fails must
   * leave the connection exactly as it was, which is what `restore` is for.
   *
   * Reading the old password back to be able to restore it is the one place in
   * the app that reads a stored password into memory. It is the user's own
   * secret, in the user's own process, for as long as one ssh takes to fail,
   * and the alternative is an edit that mistypes a password and destroys the
   * working one on its way to reporting the failure.
   */
  swapPassword(id: string, auth: AuthMode, password: string | null): Promise<{ error: string; restore: () => Promise<void> }>;
  /** Store an edit that `reviewUpdate` passed and the caller has committed to. */
  write(conn: Connection): Promise<void>;
  remove(id: string): Promise<{ ok: boolean; error: string }>;
  probe(destination: string, port: number): Promise<{ hostKey: string; fingerprint: string; keyType: string; error: string }>;
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

/**
 * The keychain, as four functions (bun/secrets.ts).
 *
 * A seam rather than a direct import so that a test suite can exercise the
 * password door without writing to the login keychain hundreds of times a day.
 * The real thing is a native seam and is proved by the live probe (testing.md
 * §6); what is worth testing here is the ORDER — which of the write, the dial
 * and the record happens first, and what is put back when one of them fails.
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
  /** Defaults to nothing in use, which is what every test and the first moment
   * of boot both want. */
  inUse?: () => Iterable<string>;
  /** Defaults to the real keychain. */
  secrets?: Secrets;
} = {}): Promise<ConnectionStore> {
  const now = deps.now ?? (() => Date.now());
  const inUse = deps.inUse ?? (() => []);
  const secrets = deps.secrets ?? REAL_SECRETS;
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
        // No key is offered on the password door (`PubkeyAuthentication=no`),
        // so a path left behind in the form is dropped rather than stored as a
        // field with no effect that a later reader would have to explain.
        keyPath: auth === "password" ? "" : keyPath.trim(),
        auth,
        hostKey: hostKey.trim(),
        lastReached: 0,
      };
      // The secret first: a record naming a password door that has no password
      // behind it is a connection that can only fail, and it would fail with
      // ssh's words rather than with the keychain's.
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
        // Null means "keep what is stored", which is only an answer when there
        // is something stored. A connection moved onto the password door with
        // nothing behind it would dial, find no secret, and be refused by the
        // far end for a reason that is on this machine.
        if (password === null) {
          if (!(await secrets.has(id))) return { conn: null, error: "That connection has no password stored. Enter one." };
        } else {
          const unusable = validatePassword(password);
          if (unusable) return { conn: null, error: unusable };
        }
      }
      // Null keeps what is pinned; a line replaces it. Either way a pin is a
      // claim about one machine, and carrying one to another address would
      // refuse every later connection with a message about a CHANGED host key
      // — so the caller reads the new machine's fingerprint instead
      // (remote.md §4), and this is what makes forgetting to impossible.
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
      // Two ways there is nothing to swap, and between them they are every
      // rename and every re-address: a connection that was on the key door and
      // stays there has no secret to move, and one on the password door whose
      // form did not ask for a new password keeps the one it has. Neither
      // should cost a keychain spawn.
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
      // removing a connection removes its pin in the same breath — and the id
      // this client was known by there goes with it, which is what keeps the
      // map bounded by the list (remote.md §8a).
      await persist();
      await forgetClientId(id);
      // And its password, for the same reason the pin goes: a credential that
      // outlived the connection it belonged to is one nothing in the app can
      // show, edit, or delete. Only when the record used one, so removing an
      // ordinary connection costs no keychain call at all.
      if (gone.auth === "password") await secrets.forget(id);
      return { ok: true, error: "" };
    },

    probe: async (destination, port) => {
      const probed = await probeHostKey(destination.trim(), port);
      return "error" in probed ? { hostKey: "", fingerprint: "", keyType: "", error: probed.error } : { ...probed, error: "" };
    },
  };
}

/** A swap that moved nothing, so undoing it is also nothing. */
const NOTHING_SWAPPED = { error: "", restore: async (): Promise<void> => {} };

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
