// The view's window onto which machine it is talking to (remote.md §8).
//
// Mirrors lib/clipboard.ts: main.tsx configures it with the real RPC,
// harness.tsx with a fake, and everything above reads through these functions.
// Unlike settings, this one is subscribable — the status changes when a
// connection is added, removed, or switched to, and the indicator in the
// chrome has to follow. It is a small mirror rather than store state because
// nothing about the notes depends on it: it is the frame around them.
import type { AuthMode } from "../../shared/connections";
import type { ConnectionInfo, PeerInfo } from "../../shared/rpc-schema";

export interface ConnectionStatus {
  connections: ConnectionInfo[];
  /** The connection actually being served. */
  active: string;
  /** What the user last chose. Differs from `active` only when that could not
   * be opened, in which case `error` says why. */
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
    /** On its way to the keychain and nowhere else, and only when `auth` says
     * password. It never comes back: nothing in this file can read one. */
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
    /** Null keeps whatever is stored, which is what a rename sends. */
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

// Until configured: one connection, this machine, no trouble. A boot that
// failed to reach Bun still renders chrome that says something true — the app
// it is drawing is running on this Mac either way.
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
 * Whether the wire is up (remote.md §7), pushed by this app's own Bun side
 * rather than by a server: the end on the far side of a dropped connection is
 * in no position to mention it.
 *
 * Kept beside the connection status rather than in the store because it is the
 * same fact at a finer grain — which machine, and whether we can currently
 * reach it — and the indicator that renders one renders the other.
 */
export type LinkState = "live" | "reconnecting" | "lost";

let link: { state: LinkState; detail: string } = { state: "live", detail: "" };

/**
 * Who ELSE is connected to this server (rpc-schema `presence`).
 *
 * Empty is the ordinary answer rather than an unknown one: a Mac talking to the
 * server in its own process is alone by construction, and nothing is drawn
 * until somebody else is actually there.
 *
 * Beside the link state for the same reason that is beside the connection: one
 * fact at three grains — which machine, whether we can reach it, and who else
 * is on it — and one piece of chrome draws all three.
 */
let others: PeerInfo[] = [];

export function linkState(): { state: LinkState; detail: string } {
  return link;
}

export function recordLinkState(state: LinkState, detail: string): void {
  if (link.state === state && link.detail === detail) return;
  link = { state, detail };
  // A wire that is down cannot tell us who else is up. Clearing rather than
  // keeping the last list is what stops the bar naming a phone that left while
  // we were not connected to hear it; the server announces to everybody on the
  // next arrival, which is this client's own reconnect (bun/daemon.ts).
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

/** What to call another client, by the id a push named it with. Empty when
 * this client has never been told about it — a device that left between taking
 * the shell and this being asked, or one that gave no name. */
export function labelFor(client: string): string {
  return others.find((p) => p.client === client)?.label ?? "";
}

/**
 * Dial now (rpc-schema.ts connectionReconnect).
 *
 * A connection that stopped answering is retried on its own beat, measured in
 * tens of seconds (shared/transport.ts). This is for the moments something
 * outside knows better than the beat does: a machine that woke, an interface
 * that came back, a person who pressed the button.
 *
 * Nothing to await and nothing to report. What came of it arrives the way every
 * other link change does, as a `connectionState` push, because that is the
 * answer whether this asked for it or not.
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
 * Switch, and rebuild everything if it worked.
 *
 * Everything workspace-scoped is scoped to a server (remote.md §8), and this
 * view's boot is what builds all of it: the registry, the note lists, the
 * tags, the layout. So the rebuild IS a reload — pending saves are flushed
 * first, and then the page starts over against the new machine. Tearing the
 * same state down in place would mean a second, less-tested teardown path for
 * every module that holds a configureX singleton.
 *
 * Returns the refusal when the connection would not open, in which case
 * nothing was torn down and the session carries on where it was.
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
 * Change one, and rebuild the session when what changed is how the connection
 * being served is MADE.
 *
 * The reload is `selectConnection`'s, for the same reason: the shell has
 * re-opened the wire against the new address, so everything server-scoped in
 * this page is now the previous machine's. A rename needs none of it, which is
 * why the caller says which kind of edit this was rather than this guessing.
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
