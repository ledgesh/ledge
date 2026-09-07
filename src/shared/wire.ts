// The wire between a Ledge client and a Ledge server (remote.md §3).
//
// Both ends speak it and neither owns it, so it sits in shared/:
// shared/transport.ts is the client's half and bun/transport.ts the server's,
// over a child process's pipes here and an ssh child there. Nothing in this
// file does I/O: it turns bytes into messages and back, and that is all. Doing
// no I/O is what lets the client's half run in a webview (ios.md §2) instead
// of being rewritten in Swift.
//
// A frame is a 4-byte big-endian length, a 1-byte type, then that many bytes
// of payload. Type 0 is a JSON control frame: requests, responses, the
// schema's push messages, and the heartbeat. Type 1 is a binary payload whose
// first 4 bytes are the id of the control frame it belongs to.
//
// A binary frame is sent immediately before the control frame that claims it,
// and a receiver holds at most one. Stream order is guaranteed, so the payload
// a control frame refers to is always the one that just arrived. No
// correlation table is needed, no partial state a peer can grow, and two
// binary frames with no control frame between them are a desync rather than a
// queue.
//
// The frame parser is the whole new attack surface a forced-command key
// exposes (remote.md §4), so it does as little as it can: a fixed header, a
// hard length cap checked before any buffering, no allocation sized by a
// number the peer chose, and structural validation of every control message on
// arrival. The client is the least-trusted end (remote.md §2), and a frame it
// sent is the least-trusted thing it sends.
import type { LedgeRPC } from "./rpc-schema";

/**
 * Bumped when the framing changes, when the control messages change shape, or
 * when a payload changes shape under a name that stays the same. A peer on a
 * different version is refused rather than partly understood. This and the
 * role check are now the only refusals (remote.md §11). A person bumps this
 * number rather than deriving it, so `rpc-schema.shape.test.ts` fails when the
 * schema's types change and this line does not.
 */
export const PROTOCOL_VERSION = 5;

export const FRAME_HEADER_BYTES = 5;

/** The cap on one frame. Big enough for a scrollback replay (256 KB of pty
 * bytes, base64) and a pasted screenshot, small enough that a lying length is
 * refused rather than allocated. A payload that needs more than this is a
 * design bug at this boundary, not a reason to raise the number. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export const CONTROL_FRAME = 0;
export const BINARY_FRAME = 1;

export type Frame =
  | { type: typeof CONTROL_FRAME; text: string }
  | { type: typeof BINARY_FRAME; id: number; bytes: Uint8Array };

/** A stream that cannot be parsed. Always fatal to the connection: a
 * length-prefixed protocol cannot resynchronize once its framing is in doubt,
 * and carrying on turns a desync into silent data corruption. */
export class WireError extends Error {
  override readonly name = "WireError";
}

// --- messages ----------------------------------------------------------------

/** The first frame in each direction (remote.md §11). */
export interface Hello {
  t: "hello";
  role: "client" | "server";
  protocol: number;
  build: string;
  // What this end can be asked to do, and what it may push: the server's
  // WIRE_METHODS and PUSH_MESSAGES, as the names themselves rather than a hash
  // of them (remote.md §11 for why a list). Empty from a client, which answers
  // CLIENT_METHODS and raises CLIENT_PUSHES at home, and empty from a server
  // that predates the fields. Empty reads as "says nothing, so assume it can
  // do anything", so the one call fails rather than the connection. Both are
  // intersected with this end's own lists on arrival, so a peer cannot grow
  // this client's memory by sending a million names.
  methods: string[];
  pushes: string[];
  // Who is connecting. The server files this client's saved layout under it
  // (remote.md §5), so a phone does not inherit a desktop's three-pane
  // arrangement and the same Mac gets its own back. Identity belongs to the
  // connection rather than to each request: a client cannot forget to send it,
  // and no handler needs a parameter it would fill in only one way.
  //
  // Empty from a server, and empty is allowed from a client too. A client with
  // no layout to keep has no id, and the server files it under a shared key
  // rather than refusing the connection over a preference.
  client: string;
  // What that device calls itself: a Mac's hostname, a phone's device name,
  // taken from the device rather than typed by the user. The id above is
  // opaque and always will be, because it keys files; this is the half a
  // person can read. Presence uses it (remote.md §7), so a user sees "iPhone
  // took your shell" rather than "another device took your shell". Empty from
  // a server, which is named instead by the connection that reaches it, the
  // user's own word for it (remote.md §8). Empty is allowed from a client,
  // which is then an unnamed device on screen. Bounded and stripped of control
  // characters on arrival (`cleanLabel`): the client is the least-trusted end
  // (remote.md §2), and this is the one string it chooses that another
  // client's screen displays.
  label: string;
  // Which run of the server this is: a nonce minted once per daemon process,
  // empty from a client. A reconnecting client replays what was in flight
  // under the same op ids, and the op log that makes that safe lives in the
  // server's memory (bun/opLog.ts), so a different instance answering is the
  // one case where replaying would apply a write twice. Comparing this is how
  // a client tells "the wire came back" from "the server came back".
  instance: string;
  // How long this client asks the server to keep its sessions alive after the
  // connection ends, in milliseconds; 0 from a client that does not ask. From
  // a server it is the longest hold it will grant, stated before it has heard
  // anyone ask. The two hellos cross rather than answering each other, so no
  // grant travels back in this handshake: both ends apply `sessionHold` to the
  // pair and reach the same number, which costs no round trip and leaves the
  // term the server's (remote.md §7). Absent from a peer that predates the
  // field, where 0 means no hold, the behavior that peer already had. So this
  // does not bump PROTOCOL_VERSION: neither the framing nor the message set
  // changed shape, and refusing an older peer would be a worse answer than the
  // one it already gives.
  hold: number;
}

/**
 * Every control frame. `id` correlates a response with its request and nothing
 * else: frames are interleaved freely, so a slow search does not hold up the
 * keystroke behind it.
 */
export type WireMessage =
  | Hello
  // A client asking the server to run one of the schema's request handlers.
  // `op` is the dedupe key (remote.md §7): present on everything a replay
  // could apply twice, absent on the reads where running it again is the same
  // as running it once. `bin` says a binary frame just arrived carrying one of
  // this payload's fields.
  | { t: "req"; id: number; m: string; p: unknown; op?: string; bin?: number }
  | { t: "res"; id: number; r: unknown; bin?: number }
  // A handler that threw. Only the message travels: a stack trace names the
  // server's own paths, and the view has never had one.
  | { t: "err"; id: number; e: string }
  // One of the schema's webview messages, server to client, unsolicited.
  | { t: "push"; m: string; p: unknown; bin?: number }
  // The heartbeat (remote.md §7). A client that has heard nothing for a while
  // asks, and a server answers the moment it is asked. It runs in that
  // direction only: `ping` is a client's to send and `pong` a server's. The
  // client is the end with a reconnect ladder to climb, an indicator to draw,
  // and a network under it that goes away. The server only has to listen,
  // since a client that has gone silent has gone. Either frame arriving from
  // the wrong side is a peer out of sync, refused like every other frame sent
  // in the wrong direction.
  //
  // No fields, no id. A pong says the far end is still there, not which probe
  // was answered, and so does any other frame arriving. Nothing has to be
  // correlated, and there is nothing here for a peer to lie about the size of.
  | { t: "ping" }
  | { t: "pong" }
  // The last frame before a deliberate hangup, carrying why. A refused
  // handshake has no request to answer, so without this the client would see
  // only a closed pipe and could not say what was wrong.
  //
  // `back` is the server saying it is stopping rather than refusing, and
  // expects to be reachable again. A goodbye otherwise ends the line for that
  // client (shared/transport.ts), which is right for a displaced connection
  // and wrong for a restart. A restart is the one outage a server can
  // announce; no other kind is announced at all. Absent means final, the
  // behavior a peer that predates the field already had, so this does not bump
  // PROTOCOL_VERSION either (`hold` above, same reasoning): an old server on
  // the far end costs a press of Reconnect rather than a refused connection.
  | { t: "bye"; why: string; back?: boolean };

// --- the method surface ------------------------------------------------------

type RequestMethod = keyof LedgeRPC["bun"]["requests"];
type PushMessage = keyof LedgeRPC["webview"]["messages"];

/**
 * Every request the protocol carries. The server dispatches by name into its
 * own handler map, so this list is not what makes a call work. It exists so a
 * client can be built from it (a client has no handlers to enumerate) and so
 * the two ends can fingerprint what they each believe the protocol is.
 */
export const REQUEST_METHODS = [
  "workspaceList",
  "workspaceCreate",
  "workspaceAttach",
  "workspaceDetach",
  "workspaceMove",
  "noteList",
  "noteRead",
  "noteWrite",
  "noteCreate",
  "noteMove",
  "folderRename",
  "folderDelete",
  "noteRetitle",
  "noteFavorite",
  "dailyOpen",
  "noteFromTemplate",
  "noteDelete",
  "noteStash",
  "noteSearch",
  "noteBacklinks",
  "tagList",
  "tagNotes",
  "trashList",
  "trashRestore",
  "trashDelete",
  "trashEmpty",
  "runBlock",
  "cancelRun",
  "inlineResize",
  "inlineInput",
  "inlineClaim",
  "terminalInput",
  "terminalPaste",
  "terminalResize",
  "terminalAttach",
  "terminalDetach",
  "terminalStatus",
  "terminalClaim",
  "closeSession",
  "sessionConfigure",
  "sessionRestart",
  "profileRead",
  "profileWrite",
  "clipboardWrite",
  "clipboardRead",
  "clipboardReadRich",
  "menuSet",
  "windowNew",
  "windowDocs",
  "windowRole",
  "settingsGet",
  "settingsRead",
  "settingsWrite",
  "cliInstall",
  "logAppend",
  "logReveal",
  "assetRead",
  "assetPaste",
  "assetPick",
  "assetWrite",
  "connectionList",
  "connectionSelect",
  "connectionReconnect",
  "connectionAdd",
  "connectionUpdate",
  "connectionRemove",
  "connectionProbe",
  "layoutGet",
  "layoutSave",
  "openRequestTake",
  "vaultState",
  "vaultCreate",
  "vaultUnlock",
  "vaultLock",
  "noteLock",
  "noteRemoveLock",
  "vaultChangePassphrase",
  "linkOpen",
] as const satisfies readonly RequestMethod[];

/** Every message the server pushes, unsolicited. */
export const PUSH_MESSAGES = [
  "runEvent",
  "terminalOutput",
  "terminalBusy",
  "terminalExit",
  "terminalDetached",
  "presence",
  "notesChanged",
  "openExternal",
  "vaultChanged",
  "menuCommand",
] as const satisfies readonly PushMessage[];

/**
 * Pushes the client shell raises itself, which no server may send. The mirror
 * of CLIENT_METHODS below, on the other direction of the wire: a connection's
 * state is a fact about the wire, and the end holding the far side of a
 * dropped one cannot report it.
 */
export const CLIENT_PUSHES = ["connectionState", "docsShow"] as const satisfies readonly PushMessage[];

export type ClientPush = (typeof CLIENT_PUSHES)[number];

// --- what never becomes a frame ----------------------------------------------
//
// The lists above name what the protocol carries; these name what it refuses.
// They sit here rather than beside their implementations because every shell
// needs them and the shells are in different places, in different languages:
// bun/clientSeams.ts serves the first group on a Mac, bun/connectionManager.ts
// the second, and mainview/lib/nativeBridge.ts serves both on iOS, where the
// implementations are Swift's and only the list is portable (ios.md §2).
// bun/server.ts refuses exactly these names, keyed by ClientMethod, so a name
// added here without a matching refusal fails to compile.

/**
 * The native ten: the pasteboard, the picture library, the browser, the menu
 * bar, and the windows. All of them belong to the device in front of the user.
 *
 * Answering them on the server reaches the wrong machine: a VPS's empty
 * pasteboard, a file dialog opened on a screen nobody is looking at, a link
 * opened in a browser nobody is looking at, a menu bar that does not exist and
 * takes ⌘Q with it (remote.md §10), a window on a machine with no screen.
 */
export const NATIVE_METHODS = [
  "clipboardRead",
  "clipboardWrite",
  "clipboardReadRich",
  "assetPaste",
  "assetPick",
  "linkOpen",
  "menuSet",
  "windowNew",
  "windowDocs",
  "windowRole",
] as const satisfies readonly RequestMethod[];

export type NativeMethod = (typeof NATIVE_METHODS)[number];

/** The seven the view drives connections with. Which servers this app can
 * connect to is nobody's business but this app's: a server asked to list them
 * would be answering about somebody else's client (remote.md §8). */
export const CONNECTION_METHODS = [
  "connectionList",
  "connectionSelect",
  "connectionReconnect",
  "connectionAdd",
  "connectionUpdate",
  "connectionRemove",
  "connectionProbe",
] as const satisfies readonly RequestMethod[];

export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

/** Everything a client shell serves itself, and a server refuses. */
export const CLIENT_METHODS = [...NATIVE_METHODS, ...CONNECTION_METHODS] as const satisfies readonly RequestMethod[];

export type ClientMethod = (typeof CLIENT_METHODS)[number];

const CLIENT_ONLY = new Set<string>(CLIENT_METHODS);

/**
 * The requests that actually become frames: every name a server answers.
 *
 * CLIENT_METHODS are subtracted because no frame ever carries one. The client
 * shell answers them at home and bun/server.ts refuses them by name, so a
 * server has nothing to change when one is added. This is also the list
 * `hello()` declares to the peer, and the subtraction matters there too. A
 * window verb, a clipboard flavor or another way to edit a connection is a
 * fact about a client. Comparing one against a server must not refuse a server
 * that is running the same protocol perfectly well (remote.md §11).
 *
 * PUSH_MESSAGES needs no such subtraction, since CLIENT_PUSHES is already a
 * separate list, for the same reason on the other direction of the wire.
 */
export const WIRE_METHODS: readonly RequestMethod[] = REQUEST_METHODS.filter((m) => !CLIENT_ONLY.has(m));

// Exhaustiveness, in the direction `satisfies` cannot see. `satisfies` refuses
// a name the schema does not have; these types refuse a schema name the lists
// do not have, and the compiler's error is the missing method's own name.
// Between them, adding to rpc-schema.ts without adding here does not build.
type MissingRequest = Exclude<RequestMethod, (typeof REQUEST_METHODS)[number]>;
type MissingPush = Exclude<PushMessage, (typeof PUSH_MESSAGES)[number] | ClientPush>;
const everyRequestListed: MissingRequest extends never ? true : MissingRequest = true;
const everyPushListed: MissingPush extends never ? true : MissingPush = true;
void everyRequestListed;
void everyPushListed;

// --- the same surface as handler maps ----------------------------------------
//
// The lists above name the protocol; these three give it a shape a transport
// can dispatch into. They sit here rather than beside a server because both
// ends need them: a client presents a RequestHandlers it satisfies over the
// wire, and shared/transport.ts is the code that does it.

/**
 * The push half: `webview.messages` in rpc-schema.ts, one method per message.
 * The Mac shell implements it over the Electrobun RPC; a socket transport
 * implements it by writing frames.
 */
export type ViewPush = {
  [K in keyof LedgeRPC["webview"]["messages"]]: (payload: LedgeRPC["webview"]["messages"][K]) => void;
};

/**
 * What a server may push. CLIENT_PUSHES are subtracted rather than stubbed:
 * `connectionState` is a fact about the wire, and the end on the far side of a
 * dropped one cannot report it (remote.md §7). Leaving it in this type would
 * hand every server a method whose only correct implementation is not to call
 * it.
 */
export type ServerPush = Omit<ViewPush, ClientPush>;

/**
 * The request half, derived from the schema rather than from Electrobun's
 * generics, so this object is a plain map any transport can call. Binding it to
 * `defineRPC` is then a pass-through, and the socket transport dispatches into
 * the same seam.
 */
export type RequestHandlers = {
  [K in keyof LedgeRPC["bun"]["requests"]]: (
    params: LedgeRPC["bun"]["requests"][K]["params"],
  ) => LedgeRPC["bun"]["requests"][K]["response"] | Promise<LedgeRPC["bun"]["requests"][K]["response"]>;
};

/**
 * The same map from the calling side, where every answer is a promise.
 *
 * An implementor may answer synchronously and often does (half of
 * bun/server.ts's handlers are plain functions), so RequestHandlers admits
 * both. A caller cannot: the answer may be on another machine, and code that
 * reads it has to await either way. Stating that separately lets the view be
 * written once against `requests.noteList({…}).then(…)` and bound to
 * Electrobun on the Mac and to a socket on iOS (ios.md §2). Assignable to
 * RequestHandlers, never the other way round.
 */
export type RequestClient = {
  [K in keyof LedgeRPC["bun"]["requests"]]: (
    params: LedgeRPC["bun"]["requests"][K]["params"],
  ) => Promise<LedgeRPC["bun"]["requests"][K]["response"]>;
};

// --- what a replay may repeat ------------------------------------------------

/**
 * The requests a reconnecting client may simply send again, because running
 * one twice is indistinguishable from running it once. Everything else carries
 * an `op` and the server dedupes on it (remote.md §7).
 *
 * The list names the reads rather than the writes, so a method nobody
 * classified defaults to being deduped. That costs an entry in a bounded
 * window. The other default would cost a note saved twice, its own divergence
 * guard tripping on its own bytes, and a trash copy of the user's work.
 */
export const READ_ONLY_METHODS = [
  "workspaceList",
  "noteList",
  "noteRead",
  "noteSearch",
  "noteBacklinks",
  "tagList",
  "tagNotes",
  "trashList",
  "terminalStatus",
  // The one entry here that is not simply a read. It writes at most
  // `owner = the caller`, which is where a second attempt would leave it
  // anyway. And it must be re-asked rather than answered from the op record: a
  // claim is a question about right now, and a recorded answer would tell a
  // client it still holds a shell that has since moved.
  "terminalClaim",
  "profileRead",
  "settingsGet",
  "settingsRead",
  "assetRead",
  "layoutGet",
  "vaultState",
] as const satisfies readonly RequestMethod[];

const READ_ONLY = new Set<string>(READ_ONLY_METHODS);

/** Whether a request must carry an `op`. An unknown name answers true: the
 * caller is about to send that method, and defaulting an unrecognized one to
 * "dedupe it" is the harmless direction. */
export function needsOp(method: string): boolean {
  return !READ_ONLY.has(method);
}

// --- what rides a binary frame -----------------------------------------------

/**
 * The base64 fields that travel as bytes instead, by message kind and method.
 * Keyed `<kind>:<method>`; the value is the path to the field inside the
 * payload, so a nested one (assetRead's image, which may be null) is reachable
 * without a rule per shape.
 *
 * The schema still says base64 everywhere, and the view still receives base64.
 * Electrobun's bridge is JSON either way, so this is an optimization for the
 * hop that has a network in it and a no-op for the one that does not. It saves
 * the 33% base64 costs on the two payloads big enough to matter: a screenshot
 * and a scrollback replay.
 */
export const BINARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "req:assetWrite": ["dataB64"],
  "res:assetRead": ["image", "dataB64"],
  "res:terminalAttach": ["dataB64"],
  // The same scrollback terminalAttach returns. The "held" and "gone" answers
  // carry no dataB64, and hoistBinary skips a field that is not there, so
  // those cost no frame.
  "res:terminalClaim": ["dataB64"],
  "push:terminalOutput": ["dataB64"],
};

export function binaryPath(kind: "req" | "res" | "push", method: string): readonly string[] | null {
  return BINARY_FIELDS[`${kind}:${method}`] ?? null;
}

/**
 * Pull the base64 at `path` out of a payload and return it as bytes, with the
 * field blanked in a shallow copy. Returns null when the field is absent or
 * empty: a missing image stays `null` in the payload, and an empty string is
 * skipped rather than sent as a frame carrying nothing. Only the objects along
 * the path are copied, so the caller's payload is untouched and the rest of it
 * is shared.
 */
export function hoistBinary(payload: unknown, path: readonly string[]): { payload: unknown; bytes: Uint8Array } | null {
  const at = walk(payload, path);
  if (at === null || typeof at.value !== "string" || at.value === "") return null;
  return { payload: replace(payload, path, ""), bytes: fromBase64(at.value) };
}

/** The inverse of hoistBinary: put the bytes back at `path`, as base64. */
export function restoreBinary(payload: unknown, path: readonly string[], bytes: Uint8Array): unknown {
  return replace(payload, path, toBase64(bytes));
}

function walk(payload: unknown, path: readonly string[]): { value: unknown } | null {
  let at: unknown = payload;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return null;
    at = (at as Record<string, unknown>)[key];
  }
  return { value: at };
}

function replace(payload: unknown, path: readonly string[], value: string): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const [head, ...rest] = path;
  if (head === undefined) return payload;
  const copy = { ...(payload as Record<string, unknown>) };
  copy[head] = rest.length === 0 ? value : replace(copy[head], rest, value);
  return copy;
}

/**
 * The TC39 base64 builtins, rather than `Buffer` or `atob`. Both conversions
 * run on every keystroke's echo, so they have to be native. The client half
 * also runs in a webview, which has no `Buffer` (ios.md §2). Bun and WebKit
 * both have these builtins: the harness's WebKit was probed for them, since it
 * is the engine lineage the app ships in.
 */
export function toBase64(bytes: Uint8Array): string {
  return bytes.toBase64();
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.fromBase64(text);
}

/**
 * Which of the peer's declared names this end also knows. The result is the
 * intersection, and it is `mine` that gets filtered, so what a connection
 * keeps is bounded by this end's own surface however many names the peer sent.
 * A peer that declares nothing gets null rather than an empty set: empty would
 * read as "can do nothing" and take every call down against a server that
 * predates the field.
 */
export function declared(theirs: readonly string[], mine: readonly string[]): Set<string> | null {
  if (theirs.length === 0) return null;
  const named = new Set(theirs);
  return new Set(mine.filter((m) => named.has(m)));
}

export function hello(
  role: "client" | "server",
  build: string,
  client = "",
  instance = "",
  hold = 0,
  label = "",
): Hello {
  // `serves` comes from the role rather than from a caller: which methods an
  // end serves follows from which end it is. A server that could forget to
  // declare its methods would send a hello that silently reads to the peer as
  // "assume it can do anything".
  const serves = role === "server";
  return {
    t: "hello",
    role,
    protocol: PROTOCOL_VERSION,
    build,
    methods: serves ? [...WIRE_METHODS] : [],
    pushes: serves ? [...PUSH_MESSAGES] : [],
    client,
    // Cleaned on the way out as well as on the way in, so the rule belongs to
    // the wire rather than to whichever shell asked the operating system for a
    // name. A device name with a newline in it must not reach a server that
    // predates the check.
    label: cleanLabel(label),
    instance,
    hold,
  };
}

/**
 * How long a server keeps its sessions for a client that has gone away: what
 * the client asked for, under the server's own ceiling. That ceiling is the
 * longest this server keeps a process for nobody (bun/daemon.ts
 * `HOLD_MAX_MS`). An over-long ask is clamped rather than refused, and the
 * client can see that it was clamped. Both ends compute it from the pair of
 * hellos, which cross on the wire (see `Hello.hold`).
 */
export function sessionHold(asked: number, ceiling: number): number {
  return Math.max(0, Math.min(asked, ceiling));
}

/**
 * null when the peer is compatible, else the refusal to report and hang up on.
 * Both versions are always named: "incompatible" with no numbers in it is a
 * message nobody can act on (remote.md §11).
 *
 * Only two things refuse. A peer on the wrong end of the wire answers
 * questions it has no business answering. A peer on another PROTOCOL_VERSION
 * may put different bytes behind the same names, and a partly understood
 * protocol makes silent data-shaped bugs.
 *
 * A name one end knows and the other does not is not a refusal, and must not
 * become one again. It was refused here until a fingerprint over the method
 * surface refused every deployed server the moment `windowDocs` and
 * `windowRole` were added, two verbs no server has ever answered. A rule like
 * that makes the client and the server a matched pair that must ship together
 * forever (remote.md §11). Such a call now fails on its own, naming itself and
 * both builds, and everything else on the connection keeps working. A
 * differing build is not a refusal either, and is what the upgrade offer
 * reads.
 */
export function checkHello(peer: Hello, expect: "client" | "server"): string | null {
  if (peer.role !== expect) return `expected to be talking to a ${expect}, and the peer says it is a ${peer.role}`;
  if (peer.protocol !== PROTOCOL_VERSION) {
    return `protocol version ${peer.protocol} on the ${peer.role} (build ${peer.build}), ${PROTOCOL_VERSION} here. ${upgrade(peer)}`;
  }
  return null;
}

/**
 * Which end to upgrade, in a sentence appended to the two version numbers.
 * The numbers are the diagnosis and this is the instruction: "protocol version
 * 4 on the server, 5 here" says nothing to a user who does not already know
 * what the number is. It always names the older end, whichever that turns out
 * to be, since the older build is the one that has never heard of the newer.
 */
function upgrade(peer: Hello): string {
  const weAreOlder = PROTOCOL_VERSION < peer.protocol;
  if (peer.role === "server") {
    return weAreOlder ? "Update this app to match that server." : "Update ledge-server on that machine, then try again.";
  }
  return weAreOlder ? "Update ledge-server on this machine." : "Update Ledge on that device.";
}

// --- encoding ----------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeU32(into: Uint8Array, at: number, n: number): void {
  into[at] = (n >>> 24) & 0xff;
  into[at + 1] = (n >>> 16) & 0xff;
  into[at + 2] = (n >>> 8) & 0xff;
  into[at + 3] = n & 0xff;
}

function readU32(from: Uint8Array, at: number): number {
  return ((from[at]! << 24) | (from[at + 1]! << 16) | (from[at + 2]! << 8) | from[at + 3]!) >>> 0;
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_BYTES) {
    throw new WireError(`a ${payload.length}-byte frame is over the ${MAX_FRAME_BYTES}-byte cap`);
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  writeU32(out, 0, payload.length);
  out[4] = type;
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

export function encodeControl(msg: WireMessage): Uint8Array {
  return frame(CONTROL_FRAME, encoder.encode(JSON.stringify(msg)));
}

export function encodeBinary(id: number, bytes: Uint8Array): Uint8Array {
  const payload = new Uint8Array(4 + bytes.length);
  writeU32(payload, 0, id);
  payload.set(bytes, 4);
  return frame(BINARY_FRAME, payload);
}

// --- decoding ----------------------------------------------------------------

/**
 * Structural validation of one control frame. Every field a dispatcher will
 * touch is checked here, at the boundary, so nothing downstream has to ask
 * whether `m` is a string.
 */
export function parseControl(text: string): WireMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return bad("a control frame that is not JSON");
  }
  if (typeof raw !== "object" || raw === null) return bad("a control frame that is not an object");
  const m = raw as Record<string, unknown>;
  switch (m["t"]) {
    case "hello":
      if (m["role"] !== "client" && m["role"] !== "server") return bad("a hello with no role");
      if (typeof m["protocol"] !== "number") return bad("a hello with no protocol version");
      if (typeof m["build"] !== "string") return bad("a hello with no build");
      // A peer that predates the `client` field is not refused here.
      // checkHello owns compatibility and refuses this one on the protocol
      // version with both numbers named, which reads better than "a hello with
      // no client".
      if (m["client"] !== undefined && typeof m["client"] !== "string") return bad("a hello with a non-string client");
      if (m["instance"] !== undefined && typeof m["instance"] !== "string") return bad("a hello with a non-string instance");
      // Structural, unlike the type checks above, because the server does
      // arithmetic on this number and the client chose it: a NaN makes every
      // comparison against it false, and the timer it ends up in would be
      // armed for nothing. Absent is still fine, and means no hold.
      if (m["hold"] !== undefined && (typeof m["hold"] !== "number" || !Number.isFinite(m["hold"]) || m["hold"] < 0)) {
        return bad("a hello with an unusable hold");
      }
      return {
        t: "hello",
        role: m["role"],
        protocol: m["protocol"],
        build: m["build"],
        // Absent is empty rather than a refusal, and empty means "declared
        // nothing", which `declared()` reads as the permissive answer. A
        // non-string entry is dropped rather than refused: the list is
        // intersected with this end's own names before use, so a number in it
        // could never have matched one, and hanging up over it would refuse a
        // connection on behalf of a name that does not exist.
        methods: names(m["methods"]),
        pushes: names(m["pushes"]),
        client: typeof m["client"] === "string" ? m["client"] : "",
        // The label is cleaned rather than checked. `cleanLabel` reduces any
        // shape to something displayable, and refusing a connection over a
        // device name would hang up on a phone over a cosmetic string.
        label: cleanLabel(m["label"]),
        instance: typeof m["instance"] === "string" ? m["instance"] : "",
        hold: typeof m["hold"] === "number" ? m["hold"] : 0,
      };
    case "req": {
      if (!isId(m["id"]) || typeof m["m"] !== "string") return bad("a request with no id or method");
      // Capped, because it becomes a key in a map the server keeps: a peer
      // that can choose the key can choose how much memory the entry costs.
      if (m["op"] !== undefined && (typeof m["op"] !== "string" || m["op"].length > MAX_OP_CHARS)) {
        return bad("a request with an unusable op id");
      }
      return { t: "req", id: m["id"], m: m["m"], p: m["p"], ...opt("op", m["op"]), ...bin(m["bin"]) };
    }
    case "res":
      if (!isId(m["id"])) return bad("a response with no id");
      return { t: "res", id: m["id"], r: m["r"], ...bin(m["bin"]) };
    case "err":
      if (!isId(m["id"]) || typeof m["e"] !== "string") return bad("an error with no id or message");
      return { t: "err", id: m["id"], e: m["e"] };
    case "push":
      if (typeof m["m"] !== "string") return bad("a push with no message name");
      return { t: "push", m: m["m"], p: m["p"], ...bin(m["bin"]) };
    case "bye":
      return {
        t: "bye",
        why: typeof m["why"] === "string" ? m["why"] : "no reason given",
        // Only a literal true sets `back`. Anything else (absent, a string, a
        // number a peer hoped would be truthy) leaves the bye final.
        ...(m["back"] === true ? { back: true } : {}),
      };
    // Nothing to validate, because there is nothing on them. Whatever else the
    // peer put in the object is dropped here rather than carried onwards.
    case "ping":
      return { t: "ping" };
    case "pong":
      return { t: "pong" };
    default:
      return bad(`a control frame of unknown type ${JSON.stringify(m["t"])}`);
  }
}

function bad(what: string): never {
  throw new WireError(`the peer sent ${what}`);
}

function isId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** The cap on an op id: long enough for a nonce and a counter, short enough
 * that a million of them is still a rounding error. The window that holds them
 * is bounded by count as well; this bounds each entry. */
const MAX_OP_CHARS = 128;

/** The cap on a device label: longer than any hostname a machine reports about
 * itself, short enough to sit in a sidebar. A longer label is cut rather than
 * refused, since its first 64 characters still name the device. */
const MAX_LABEL_CHARS = 64;

/**
 * A device name, made safe to hold and to show. The length is capped: the
 * server keeps one label per connection and pushes it to every other client,
 * so an unbounded string is an unbounded push. Control characters are removed:
 * a newline breaks a sidebar row, and an escape sequence runs in whatever
 * terminal tails the server log. Neither is a reason to hang up on a phone.
 */
function cleanLabel(v: unknown): string {
  return typeof v === "string" ? v.replace(/\p{Cc}/gu, " ").slice(0, MAX_LABEL_CHARS).trim() : "";
}

/**
 * A declared method or push list, made safe to hold. A non-string is not a
 * name, so it is dropped, and what is left is capped. That cap is the only
 * reason this is not a one-line filter: `declared()` would bound the result
 * anyway by intersecting it with this end's own surface, but this runs first,
 * on an array whose length the peer chose. A hello listing ten million methods
 * must not become a ten-million-entry Set before it is thrown away.
 */
function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is string => typeof n === "string").slice(0, MAX_DECLARED_NAMES);
}

/** The cap on a declared name list: comfortably over the real surface (about
 * 70 requests and 10 pushes) and far under a number worth allocating for. A
 * peer with more names than this to declare is not a Ledge server. */
const MAX_DECLARED_NAMES = 512;

// Absent stays absent. Spreading `{op: undefined}` would put the key in the
// object, and the encoder would put `"op":null` on the wire for every read.
function opt(key: string, v: unknown): Record<string, string> {
  return typeof v === "string" ? { [key]: v } : {};
}

function bin(v: unknown): { bin?: number } {
  return isId(v) ? { bin: v } : {};
}

/**
 * Bytes in, whole frames out. Chunk boundaries mean nothing: a frame may
 * arrive in twenty pieces or twenty frames in one piece, and both are ordinary
 * on a pipe.
 */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : concat(this.buf, chunk);
    const out: Frame[] = [];
    let off = 0;
    for (;;) {
      if (this.buf.length - off < FRAME_HEADER_BYTES) break;
      const len = readU32(this.buf, off);
      // Checked before buffering, not after: the cap exists to refuse a peer
      // that claims 4 GB, and waiting for those bytes to arrive first would
      // mean holding them.
      if (len > MAX_FRAME_BYTES) throw new WireError(`the peer announced a ${len}-byte frame, over the ${MAX_FRAME_BYTES}-byte cap`);
      if (this.buf.length - off - FRAME_HEADER_BYTES < len) break;
      const type = this.buf[off + 4]!;
      const start = off + FRAME_HEADER_BYTES;
      const payload = this.buf.subarray(start, start + len);
      off = start + len;
      out.push(decodeFrame(type, payload));
    }
    // slice, not subarray: the remainder becomes its own buffer so the chunk
    // it came in on can be collected, and so nothing handed out above aliases
    // memory this decoder will write into.
    if (off > 0) this.buf = this.buf.slice(off);
    return out;
  }
}

function decodeFrame(type: number, payload: Uint8Array): Frame {
  if (type === CONTROL_FRAME) return { type: CONTROL_FRAME, text: decoder.decode(payload) };
  if (type === BINARY_FRAME) {
    if (payload.length < 4) throw new WireError("a binary frame with no id");
    // Copied, so the caller owns bytes that outlive the decoder's buffer.
    return { type: BINARY_FRAME, id: readU32(payload, 0), bytes: payload.slice(4) };
  }
  throw new WireError(`the peer sent a frame of unknown type ${type}`);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// --- the binary companion, both directions -----------------------------------
//
// The two objects that keep the binary-frame rule at the top of this file.
// They live here rather than in a transport because both transports need them
// and neither owns them: the client's half is shared/transport.ts and the
// server's is bun/transport.ts, and both write companion frames.

/**
 * Write one control message, with the payload's bulky base64 field (if it has
 * one) as a binary frame immediately before it. Before, not after: the
 * receiver holds at most one waiting binary frame, so correlation is only
 * "the bytes that just arrived". Sending them afterwards would mean a control
 * frame referencing bytes not yet in hand, a state a peer could leave open.
 */
export function writeMessage(
  write: (b: Uint8Array) => void,
  msg: WireMessage,
  kind: "req" | "res" | "push",
  method: string,
): void {
  const path = binaryPath(kind, method);
  const body = msg.t === "req" ? msg.p : msg.t === "res" ? msg.r : msg.t === "push" ? msg.p : null;
  const hoisted = path && body !== null ? hoistBinary(body, path) : null;
  if (!hoisted) return write(encodeControl(msg));
  const bin = nextBinaryId();
  write(encodeBinary(bin, hoisted.bytes));
  write(
    encodeControl(
      msg.t === "req"
        ? { ...msg, p: hoisted.payload, bin }
        : msg.t === "res"
          ? { ...msg, r: hoisted.payload, bin }
          : { ...(msg as { t: "push"; m: string; p: unknown }), p: hoisted.payload, bin },
    ),
  );
}

// Correlates a binary frame with the control frame behind it and nothing else,
// so it only has to be unique against its immediate neighbour. Wrapped at 32
// bits because the field is a u32 on the wire.
let binaryId = 0;
function nextBinaryId(): number {
  binaryId = (binaryId + 1) >>> 0;
  return binaryId;
}

/**
 * The receiving side of the same rule: hold the bytes until the next control
 * frame claims them, and refuse a second binary frame before that happens. A
 * peer that could queue binary frames could make this end hold megabytes on
 * the promise of a control frame it never sends, and the cap on one frame does
 * nothing about a thousand of them.
 */
export class BinaryHolder {
  private held: { id: number; bytes: Uint8Array } | null = null;

  hold(frame: Extract<Frame, { type: 1 }>): void {
    if (this.held) throw new WireError("the peer sent two binary frames with no control frame between them");
    this.held = { id: frame.id, bytes: frame.bytes };
  }

  /** Put the bytes back into the payload the sender took them from. Also the
   * check that a claimed frame is the one that arrived. */
  claim(msg: WireMessage, kind: "req" | "res" | "push", method: string): unknown {
    const bin = msg.t === "req" || msg.t === "res" || msg.t === "push" ? msg.bin : undefined;
    const body = msg.t === "req" ? msg.p : msg.t === "res" ? msg.r : msg.t === "push" ? msg.p : null;
    // A message that did not ask for bytes does not drop held ones: that would
    // turn a desync into a silent truncation. idle() below catches it instead.
    if (bin === undefined) return body;
    const held = this.held;
    this.held = null;
    if (!held || held.id !== bin) throw new WireError("the peer claimed a binary frame that did not arrive");
    const path = binaryPath(kind, method);
    if (!path) throw new WireError(`the peer sent bytes with ${kind}:${method}, which carries none`);
    return restoreBinary(body, path, held.bytes);
  }

  /** True when no bytes are waiting. A control frame that claimed no bytes
   * must leave none behind: bytes with no claimant are a desync. */
  idle(): boolean {
    return this.held === null;
  }
}
