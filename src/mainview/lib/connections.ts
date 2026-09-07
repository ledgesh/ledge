// Which machine the view is talking to (remote.md §8). It mirrors state Bun
// owns, and the view reads it through the functions exported here. boot.tsx
// configures it with the real RPC and harness.tsx with a fake, the same way
// lib/clipboard.ts is set up. Unlike settings, it is subscribable: the
// connection bar follows a connection being added, removed, or switched to.
// Nothing about the notes depends on it, so it is not store state.
import type { AuthMode } from "../../shared/connections";
import type { ConnectionInfo, PeerInfo } from "../../shared/rpc-schema";

export interface ConnectionStatus {
  connections: ConnectionInfo[];
  /** The connection actually being served. */
  active: string;
  /** What the user last chose. It differs from `active` only when that
   * connection could not be opened, and then `error` says why. */
  wanted: string;
  error: string;
  build: string;
}

interface ConnectionHandlers {
  list: () => Promise<ConnectionStatus>;
  select: (id: string) => Promise<{ ok: boolean; error: string }>;
  reconnect: () => Promise<{ ok: boolean }>;
  add: (fields: {
    name: string;
    destination: string;
    /** Where sshd listens, or 0 to let ssh decide (shared/connections.ts). */
    port: number;
    keyPath: string;
    auth: AuthMode;
    /** The password, on its way to the keychain and nowhere else, and only
     * when `auth` is "password". Nothing in this file can read one back. */
    password: string;
    hostKey: string;
  }) => Promise<{ id: string; error: string }>;
  update: (fields: {
    id: string;
    name: string;
    destination: string;
    port: number;
    keyPath: string;
    auth: AuthMode;
    /** Null keeps the stored password. A rename sends null. */
    password: string | null;
    /** Null keeps whatever is pinned; a line replaces it; "" pins nothing. */
    hostKey: string | null;
  }) => Promise<{ ok: boolean; error: string }>;
  remove: (id: string) => Promise<{ ok: boolean; error: string }>;
  probe: (
    destination: string,
    port: number,
  ) => Promise<{ hostKey: string; fingerprint: string; keyType: string; error: string }>;
}

// The status before configureConnections runs: one connection, this machine,
// no error. A boot that never reached Bun still draws a connection bar. It
// still names This Mac, which is where the app is running either way.
const ALONE: ConnectionStatus = {
  connections: [
    { id: "local", name: "This Mac", destination: "", port: 0, keyPath: "", auth: "key", pinned: false, lastReached: 0 },
  ],
  active: "local",
  wanted: "local",
  error: "",
  build: "",
};

let status: ConnectionStatus = ALONE;
let handlers: ConnectionHandlers | null = null;
const subscribers = new Set<() => void>();

export function configureConnections(initial: ConnectionStatus, h: ConnectionHandlers): void {
  status = initial;
  handlers = h;
  emit();
}

export function connectionStatus(): ConnectionStatus {
  return status;
}

/** The connection being served, for the indicator. Never null: the local
 * server is always in the list, so there is always something to name. */
export function activeConnection(): ConnectionInfo {
  return status.connections.find((c) => c.id === status.active) ?? ALONE.connections[0]!;
}

export function subscribeConnections(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit(): void {
  for (const fn of subscribers) fn();
}

/**
 * Whether the wire is up (remote.md §7). It arrives as a `connectionState`
 * push from this app's own Bun side rather than from a server: a server on the
 * far side of a dropped connection cannot report the drop.
 *
 * It sits beside the connection status rather than in the store because the
 * connection bar draws both: which machine, and whether it is reachable.
 */
export type LinkState = "live" | "reconnecting" | "lost";

let link: { state: LinkState; detail: string } = { state: "live", detail: "" };

/**
 * The other clients connected to this server (rpc-schema `presence`).
 *
 * An empty list means nobody else is connected, not that nobody has been
 * asked: both servers push `presence` on every arrival and departure, to a
 * lone client too (bun/daemon.ts `announcePresence`, bun/index.ts
 * `announceLocalPresence`). Nothing is drawn until another client is listed,
 * and the connection bar draws that beside the machine name and link state.
 */
let others: PeerInfo[] = [];

export function linkState(): { state: LinkState; detail: string } {
  return link;
}

export function recordLinkState(state: LinkState, detail: string): void {
  if (link.state === state && link.detail === detail) return;
  link = { state, detail };
  // Clear the peer list when the wire is not live. Keeping the last one would
  // let the bar name a device that left while this client was disconnected.
  // The list comes back on the next reconnect, which is itself an arrival, and
  // an arrival is one of the events a server announces presence on
  // (remote.md §7).
  if (state !== "live") others = [];
  emit();
}

export function presence(): PeerInfo[] {
  return others;
}

export function recordPresence(list: PeerInfo[]): void {
  others = list;
  emit();
}

/** The label for another client, looked up by client id. Empty when this
 * client has no entry for that id: a device that left between taking the shell
 * and this call, or one that gave no name. */
export function labelFor(client: string): string {
  return others.find((p) => p.client === client)?.label ?? "";
}

/**
 * Dial now (rpc-schema.ts connectionReconnect). A connection that stopped
 * answering is retried anyway, on a ladder that settles to `RETRY_EVERY_MS`
 * (shared/transport.ts). Call it when that wait is pointless: a machine that
 * woke, an interface that came back, the Reconnect button. Nothing is awaited
 * and nothing is reported: the outcome arrives as a `connectionState` push,
 * as any other link change does.
 */
export function reconnectLink(): void {
  void handlers?.reconnect().catch(() => {});
}

export async function refreshConnections(): Promise<ConnectionStatus> {
  if (!handlers) return status;
  status = await handlers.list();
  emit();
  return status;
}

/**
 * Switch to another connection, and rebuild the session if it worked. The
 * rebuild is a page reload, with pending saves flushed first: this view's boot
 * builds everything server-scoped there is, so switching is a reload rather
 * than a teardown in place (remote.md §8).
 *
 * Returns the refusal when the connection would not open. Nothing is torn down
 * in that case and the session carries on where it was.
 */
export async function selectConnection(id: string, flush: () => Promise<void>): Promise<string | null> {
  if (!handlers) return "Not connected to Ledge's own process.";
  const res = await handlers.select(id);
  if (!res.ok) return res.error || "That connection could not be opened.";
  await flush().catch(() => {});
  window.location.reload();
  return null;
}

export async function addConnection(fields: {
  name: string;
  destination: string;
  port: number;
  keyPath: string;
  auth: AuthMode;
  password: string;
  hostKey: string;
}): Promise<{ id: string; error: string }> {
  if (!handlers) return { id: "", error: "Not connected to Ledge's own process." };
  const res = await handlers.add(fields);
  if (!res.error) await refreshConnections();
  return res;
}

/**
 * Change one connection, and take `selectConnection`'s reload when the edit
 * changed how the connection being served is made: the shell has re-opened the
 * wire against the new address, so everything server-scoped in this page
 * belongs to the previous machine (remote.md §8). A rename needs no reload, so
 * the caller passes `opts.reconnected` rather than have this function guess
 * (components/ConnectionPicker.tsx).
 */
export async function updateConnection(
  fields: {
    id: string;
    name: string;
    destination: string;
    port: number;
    keyPath: string;
    auth: AuthMode;
    password: string | null;
    hostKey: string | null;
  },
  opts: { reconnected: boolean; flush: () => Promise<void> },
): Promise<string | null> {
  if (!handlers) return "Not connected to Ledge's own process.";
  const res = await handlers.update(fields);
  if (!res.ok) return res.error || "That connection could not be changed.";
  if (opts.reconnected) {
    await opts.flush().catch(() => {});
    window.location.reload();
    return null;
  }
  await refreshConnections();
  return null;
}

export async function removeConnection(id: string): Promise<string | null> {
  if (!handlers) return "Not connected to Ledge's own process.";
  const res = await handlers.remove(id);
  if (!res.ok) return res.error || "That connection could not be removed.";
  await refreshConnections();
  return null;
}

export function probeConnection(
  destination: string,
  port: number,
): Promise<{ hostKey: string; fingerprint: string; keyType: string; error: string }> {
  if (!handlers) return Promise.resolve({ hostKey: "", fingerprint: "", keyType: "", error: "Not connected." });
  return handlers.probe(destination, port);
}
