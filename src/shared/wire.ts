// The wire between a Ledge client and a Ledge server (remote.md §3).
//
// Both ends speak it and neither owns it, which is why it sits in shared/:
// shared/transport.ts is the client's half and bun/transport.ts the server's,
// over a child process's pipes here and an ssh child there. Nothing in this
// file does I/O — it turns bytes into messages and back, and that is all,
// which is also what lets the client's half run in a webview (ios.md §2)
// rather than being reimplemented in Swift.
//
// A frame is a 4-byte big-endian length, a 1-byte type, then that many bytes
// of payload. Type 0 is a JSON control frame: requests, responses, and the
// schema's push messages. Type 1 is a binary payload whose first 4 bytes are
// the id of the control frame it belongs to.
//
// A binary frame is sent IMMEDIATELY BEFORE the control frame that claims it,
// and a receiver holds at most one. Ordering on a stream is guaranteed, so
// that rule turns "which payload is this" into "the one that just arrived" —
// no correlation table, no partial state a peer can grow, and a second binary
// frame with no control frame between them is a desync rather than a queue.
//
// The frame parser is the entire new attack surface a forced-command key
// exposes (remote.md §4), so it does as little as it can: a fixed header, a
// hard length cap checked BEFORE any buffering, no allocation sized by a
// number the peer chose, and structural validation of every control message
// on arrival. The client is the least-trusted end (remote.md §2) and a frame
// it sent is the least-trusted thing it sends.
import type { LedgeRPC } from "./rpc-schema";

/** Bumped when the framing or the message set changes shape. A peer speaking
 * a different one is refused, never partially understood. */
export const PROTOCOL_VERSION = 3;

export const FRAME_HEADER_BYTES = 5;

/** Big enough for a scrollback replay (256 KB of pty bytes, base64) and a
 * pasted screenshot; small enough that a lying length is refused rather than
 * allocated. A payload that genuinely needs more than this is a design bug at
 * this boundary, not a reason to raise the number. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export const CONTROL_FRAME = 0;
export const BINARY_FRAME = 1;

export type Frame =
  | { type: typeof CONTROL_FRAME; text: string }
  | { type: typeof BINARY_FRAME; id: number; bytes: Uint8Array };

/** A stream that cannot be parsed. Always fatal to the connection: there is no
 * resynchronizing a length-prefixed protocol once its framing is in doubt, and
 * pretending otherwise is how a desync becomes silent data corruption. */
export class WireError extends Error {
  override readonly name = "WireError";
}

// --- messages ----------------------------------------------------------------

/** The first frame in each direction (remote.md §11). */
export interface Hello {
  t: "hello";
  role: "client" | "server";
  protocol: number;
  schema: string;
  build: string;
  // Who is connecting. The server files this client's saved layout under it
  // (remote.md §5), so a phone does not inherit a desktop's three-pane
  // arrangement and the same Mac gets its own back. Identity belongs to the
  // CONNECTION rather than to each request: a client cannot forget to send it,
  // and no handler needs a parameter it would only ever fill in one way.
  //
  // Empty from a server, and empty is allowed from a client too — one that has
  // no layout to keep simply has no id, and the server files it under a shared
  // key rather than refusing the connection over a preference.
  client: string;
  // What that device calls itself: a Mac's hostname, a phone's device name.
  // The id above is opaque and always will be, because it keys files; this is
  // the half a person can read, and it exists because "another device took
  // your shell" is a worse sentence than "iPhone took your shell" (remote.md
  // §7, presence).
  //
  // The device's own name for itself rather than one the user types here: both
  // ends already have one, and a name nobody set is a name nobody has to keep
  // in sync with the machine it is about.
  //
  // Empty from a server — a server is named by the connection that reaches it,
  // which is the user's own word for it (remote.md §8) — and empty is allowed
  // from a client, which is then simply an unnamed device on screen.
  //
  // Bounded and stripped of control characters on arrival (`cleanLabel`): the
  // client is the least-trusted end (remote.md §2), and this is the one string
  // it chooses that another client's screen displays.
  label: string;
  // Which RUN of the server this is: a nonce minted once per daemon process,
  // empty from a client. A reconnecting client replays what was in flight
  // under the same op ids, and the op log that makes that safe lives in the
  // server's memory (bun/opLog.ts) — so a DIFFERENT instance answering is the
  // one case where replaying would apply a write twice. Comparing this is how
  // a client tells "the wire came back" from "the server came back".
  instance: string;
  // How long this client asks the server to keep its sessions alive after the
  // connection ends, in milliseconds; 0 from a client that does not ask.
  //
  // From a server it is the other half of the same number: the longest hold it
  // will grant, stated before it has heard anyone ask. The two hellos CROSS
  // rather than answering each other — the server sends its own the moment the
  // socket opens — so a grant cannot travel back in this handshake. Both ends
  // instead apply `sessionHold` to the pair and reach the same number, which
  // costs no round trip and leaves the term the server's (remote.md §7).
  //
  // Absent from a peer that predates the field, and 0 there means no hold,
  // which is the behavior that peer already had. That is why this does not bump
  // PROTOCOL_VERSION: neither the framing nor the message set changed shape,
  // and refusing an older peer outright would be a worse answer than the one it
  // already gives.
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
  // could apply twice, absent on the reads where running it again IS running
  // it once. `bin` says a binary frame just arrived carrying one of this
  // payload's fields.
  | { t: "req"; id: number; m: string; p: unknown; op?: string; bin?: number }
  | { t: "res"; id: number; r: unknown; bin?: number }
  // A handler that threw. Only the message travels: a stack trace names the
  // server's own paths, and the view has never had one.
  | { t: "err"; id: number; e: string }
  // One of the schema's webview messages, server to client, unsolicited.
  | { t: "push"; m: string; p: unknown; bin?: number }
  // The last frame before a deliberate hangup, carrying why. A refused
  // handshake has no request to answer, so without this the client would see
  // only a closed pipe and could not say what was wrong.
  | { t: "bye"; why: string };

// --- the method surface ------------------------------------------------------

type RequestMethod = keyof LedgeRPC["bun"]["requests"];
type PushMessage = keyof LedgeRPC["webview"]["messages"];

/**
 * Every request the protocol carries. The server dispatches by name into its
 * own handler map, so this list is not what makes a call work; it exists so a
 * client can be BUILT from it (it has no handlers to enumerate) and so the two
 * ends can fingerprint what they each believe the protocol is.
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
  "noteRetitle",
  "dailyOpen",
  "noteFromTemplate",
  "noteDelete",
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
 * of CLIENT_METHODS below on the other direction of the wire: the state of a
 * connection is a fact about the wire, and the end holding the far side of a
 * dropped one is in no position to report it.
 */
export const CLIENT_PUSHES = ["connectionState"] as const satisfies readonly PushMessage[];

export type ClientPush = (typeof CLIENT_PUSHES)[number];

// --- what never becomes a frame ----------------------------------------------
//
// The lists above name what the protocol carries; these name what it refuses
// to. They are here rather than beside their implementation because every
// shell needs them and the shells are in different languages' worth of
// different places: bun/clientSeams.ts serves the first group on a Mac,
// bun/connectionManager.ts the second, and mainview/lib/nativeBridge.ts serves
// both on iOS, where the implementations are Swift's and only the LIST is
// portable (ios.md §2). bun/server.ts refuses exactly these names, keyed by
// ClientMethod, so a name added here without a matching refusal fails to
// compile.

/**
 * The native seven: the pasteboard, the picture library, the browser, and the
 * menu bar.
 *
 * The pasteboard you copied from, the photos you took, the browser that should
 * open a link, and the menu bar at the top of the screen all belong to the
 * device in front of the user. Answering them on the server reaches the wrong
 * machine — a VPS's empty pasteboard, a file dialog opened on a screen nobody
 * is looking at, a link opened in a browser nobody is looking at, a menu bar
 * that does not exist and takes ⌘Q with it (remote.md §10).
 */
export const NATIVE_METHODS = [
  "clipboardRead",
  "clipboardWrite",
  "clipboardReadRich",
  "assetPaste",
  "assetPick",
  "linkOpen",
  "menuSet",
] as const satisfies readonly RequestMethod[];

export type NativeMethod = (typeof NATIVE_METHODS)[number];

/** The six the view drives connections with. Which servers this app can
 * connect to is nobody's business but this app's: a server asked to list them
 * would be answering about somebody else's client (remote.md §8). */
export const CONNECTION_METHODS = [
  "connectionList",
  "connectionSelect",
  "connectionAdd",
  "connectionUpdate",
  "connectionRemove",
  "connectionProbe",
] as const satisfies readonly RequestMethod[];

export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

/** Everything a client shell serves itself, and a server refuses. */
export const CLIENT_METHODS = [...NATIVE_METHODS, ...CONNECTION_METHODS] as const satisfies readonly RequestMethod[];

export type ClientMethod = (typeof CLIENT_METHODS)[number];

// Exhaustiveness, in the direction `satisfies` cannot see. It refuses a name
// the schema does not have; these refuse a schema name the lists do not have,
// and the compiler's error is the missing method's own name. Between them,
// adding to rpc-schema.ts without adding here does not build.
type MissingRequest = Exclude<RequestMethod, (typeof REQUEST_METHODS)[number]>;
type MissingPush = Exclude<PushMessage, (typeof PUSH_MESSAGES)[number] | ClientPush>;
const everyRequestListed: MissingRequest extends never ? true : MissingRequest = true;
const everyPushListed: MissingPush extends never ? true : MissingPush = true;
void everyRequestListed;
void everyPushListed;

// --- the same surface as handler maps ----------------------------------------
//
// The lists above name the protocol; these three give it a shape a transport
// can dispatch into. They are here rather than beside a server because both
// ends need them: a client PRESENTS a RequestHandlers it satisfies over the
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
 * What a SERVER may push. CLIENT_PUSHES are subtracted rather than stubbed:
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
 * An IMPLEMENTOR may answer synchronously and often does — half of
 * bun/server.ts's handlers are plain functions — so RequestHandlers admits
 * both. A CALLER cannot: the answer may be on another machine, and code that
 * reads it has to await either way. Stating that separately is what lets the
 * view be written once against `requests.noteList({…}).then(…)` and bound to
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
 * Stated as the READS rather than as the writes on purpose. A method nobody
 * classified then defaults to being deduped, which costs an entry in a bounded
 * window; the other default costs a note saved twice, its own divergence guard
 * tripping on its own bytes, and a trash copy of the user's work.
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
  // The one entry here that is not simply a read, and it earns its place both
  // ways. It writes at most `owner = the caller`, which is where a second
  // attempt would leave it anyway. And it must be RE-ASKED rather than answered
  // from the op record: a claim is a question about right now, and a recorded
  // answer would tell a client it still holds a shell that has since moved.
  "terminalClaim",
  "profileRead",
  "settingsGet",
  "settingsRead",
  "assetRead",
  "layoutGet",
  "vaultState",
] as const satisfies readonly RequestMethod[];

const READ_ONLY = new Set<string>(READ_ONLY_METHODS);

/** Whether a request must carry an `op`. Unknown names answer true: this is
 * asked about a method the caller is ABOUT to send, and defaulting an
 * unrecognized one to "dedupe it" is the harmless direction. */
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
 * The SCHEMA still says base64 everywhere, and the view still receives base64:
 * Electrobun's bridge is JSON either way, so this is an optimization for the
 * hop that has a network in it and a no-op for the one that does not. What it
 * buys is the 33% base64 costs, on exactly the two payloads big enough to care
 * — a screenshot and a scrollback replay.
 */
export const BINARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "req:assetWrite": ["dataB64"],
  "res:assetRead": ["image", "dataB64"],
  "res:terminalAttach": ["dataB64"],
  // The same scrollback by another name, and absent on the two answers that
  // carry none: hoistBinary skips a field that is not there, so "held" and
  // "gone" cost no frame.
  "res:terminalClaim": ["dataB64"],
  "push:terminalOutput": ["dataB64"],
};

export function binaryPath(kind: "req" | "res" | "push", method: string): readonly string[] | null {
  return BINARY_FIELDS[`${kind}:${method}`] ?? null;
}

/**
 * Pull the base64 out of a payload and return it as bytes, with the field
 * blanked in a shallow copy. null when the field is absent or empty — a
 * missing image is a `null` in the payload and not an empty frame, and an
 * empty string costs a frame to say nothing.
 *
 * Copies only the objects along the path, so the caller's payload is untouched
 * and the rest of it is shared rather than cloned.
 */
export function hoistBinary(payload: unknown, path: readonly string[]): { payload: unknown; bytes: Uint8Array } | null {
  const at = walk(payload, path);
  if (at === null || typeof at.value !== "string" || at.value === "") return null;
  return { payload: replace(payload, path, ""), bytes: fromBase64(at.value) };
}

/** The inverse: put the bytes back where the sender took them from. */
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
 * The TC39 builtins rather than `Buffer`, and not `atob` either. Both
 * conversions are on the path of every keystroke's echo, so they have to be the
 * native ones; and a client half that runs in a webview (ios.md §2) has no
 * `Buffer` to reach for. Bun and WebKit both have these — the harness's WebKit
 * was probed for it, since it is the engine lineage the app ships in.
 */
export function toBase64(bytes: Uint8Array): string {
  return bytes.toBase64();
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.fromBase64(text);
}

/**
 * FNV-1a over the sorted names. Not a hash for security: it is a fingerprint
 * that moves when the protocol's METHOD SURFACE moves, so a client and a
 * server built from different schemas refuse each other at the handshake
 * instead of failing on the first call nobody implements.
 *
 * What it does NOT see is a payload SHAPE change under an unchanged name. That
 * one rides the `build` string, which the handshake also carries and which the
 * upgrade offer reads (remote.md §11) — a mismatch there means "these are
 * different builds", which is exactly the question a shape change poses.
 */
export function fingerprint(names: readonly string[]): string {
  const text = [...names].sort().join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const SCHEMA_VERSION = fingerprint([
  ...REQUEST_METHODS.map((m) => `req:${m}`),
  ...PUSH_MESSAGES.map((m) => `push:${m}`),
]);

export function hello(
  role: "client" | "server",
  build: string,
  client = "",
  instance = "",
  hold = 0,
  label = "",
): Hello {
  // Cleaned on the way out as well as on the way in. The rule belongs to the
  // wire rather than to whichever shell asked the operating system for a name,
  // and a device whose name has a newline in it should not be able to send one
  // to a server that predates the check.
  return { t: "hello", role, protocol: PROTOCOL_VERSION, schema: SCHEMA_VERSION, build, client, label: cleanLabel(label), instance, hold };
}

/**
 * How long a server keeps its sessions for a client that has gone away: what
 * the client asked for, under the server's own ceiling.
 *
 * Both ends compute it, from the pair of hellos, because those cross on the
 * wire (see `Hello.hold`). A client asking for a day is not refused; it is
 * granted the longest this server keeps a process for nobody
 * (bun/daemon.ts `HOLD_MAX_MS`), and it can see that it was clamped.
 */
export function sessionHold(asked: number, ceiling: number): number {
  return Math.max(0, Math.min(asked, ceiling));
}

/**
 * null when the peer is compatible, else the refusal to report and hang up on.
 * Both versions are always named: "incompatible" with no numbers in it is a
 * message nobody can act on (remote.md §11). A differing BUILD is deliberately
 * not a refusal — it is what the upgrade offer reads — and a partially
 * understood protocol is never negotiated, because that is how silent
 * data-shaped bugs happen.
 */
export function checkHello(peer: Hello, expect: "client" | "server"): string | null {
  if (peer.role !== expect) return `expected to be talking to a ${expect}, and the peer says it is a ${peer.role}`;
  if (peer.protocol !== PROTOCOL_VERSION) {
    return `protocol version ${peer.protocol} on the ${peer.role}, ${PROTOCOL_VERSION} here`;
  }
  if (peer.schema !== SCHEMA_VERSION) {
    return `schema ${peer.schema} on the ${peer.role} (build ${peer.build}), ${SCHEMA_VERSION} here`;
  }
  return null;
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
 * touch is checked here, so nothing downstream has to ask whether `m` is a
 * string: the check is at the boundary or it is nowhere.
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
      if (typeof m["schema"] !== "string" || typeof m["build"] !== "string") return bad("a hello with no versions");
      // A peer that predates the field is not refused here: checkHello owns
      // compatibility, and it will refuse this one on the protocol version
      // with both numbers named, which is a far better message than "a hello
      // with no client".
      if (m["client"] !== undefined && typeof m["client"] !== "string") return bad("a hello with a non-string client");
      // The label is not checked, it is CLEANED: refusing a connection over a
      // device name would be refusing to talk to a phone about a string nobody
      // reads twice, and there is no shape it could have that this does not
      // reduce to something displayable (`cleanLabel`).
      if (m["instance"] !== undefined && typeof m["instance"] !== "string") return bad("a hello with a non-string instance");
      // Structural, unlike the two above, because this one is arithmetic the
      // server does on a number the client chose: a NaN would make every
      // comparison against it false, and the timer it ends up in would be armed
      // for nothing. Absent is still fine, and means no hold.
      if (m["hold"] !== undefined && (typeof m["hold"] !== "number" || !Number.isFinite(m["hold"]) || m["hold"] < 0)) {
        return bad("a hello with an unusable hold");
      }
      return {
        t: "hello",
        role: m["role"],
        protocol: m["protocol"],
        schema: m["schema"],
        build: m["build"],
        client: typeof m["client"] === "string" ? m["client"] : "",
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
      return { t: "bye", why: typeof m["why"] === "string" ? m["why"] : "no reason given" };
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

/** Long enough for a nonce and a counter, short enough that a million of them
 * is still a rounding error. The window that holds them is bounded by count
 * too; this bounds each entry. */
const MAX_OP_CHARS = 128;

/** Longer than any hostname a machine reports about itself, short enough to
 * sit in a sidebar. A label past it is cut rather than refused: what is on
 * screen is a name, and the first 64 characters of one still name something. */
const MAX_LABEL_CHARS = 64;

/**
 * A device name, made safe to hold and to show.
 *
 * Two things a peer must not decide for us. How much memory this costs: the
 * server keeps one per connection and pushes it to every other client, so an
 * unbounded string is an unbounded push. And what it can DO on arrival: a
 * newline in a sidebar is a broken row, and an escape sequence in a line
 * somebody tails from a server log is a terminal doing what the label said.
 * Neither is a reason to hang up on a phone, so both are simply removed.
 */
function cleanLabel(v: unknown): string {
  return typeof v === "string" ? v.replace(/\p{Cc}/gu, " ").slice(0, MAX_LABEL_CHARS).trim() : "";
}

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
      // Before buffering, not after: the cap is worth having precisely because
      // it refuses a peer that claims 4 GB, and waiting for the bytes to
      // arrive first would be agreeing to hold them.
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
// The rule at the top of this file, as the two objects that keep it. Here
// rather than in a transport because BOTH transports need it and neither owns
// it: the server writes companion frames and the client writes them, and the
// halves live in different files now (shared/transport.ts and bun/transport.ts).

/**
 * Write one control message, with the payload's bulky base64 field (if it has
 * one) as a binary frame immediately before it.
 *
 * Before, not after, and it matters: the receiver holds at most one waiting
 * binary frame, so "the bytes that just arrived" is the whole correlation
 * story. Sending them afterwards would mean a control frame that references
 * something not yet in hand, which is a state a peer could leave open.
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
 * frame claims them, and refuse a second binary frame before that happens.
 *
 * Refusing is the point. A peer that can queue binary frames can make the
 * other end hold megabytes on the promise of a control frame it never sends,
 * and the cap on one frame does nothing about a thousand of them.
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
    // Held bytes are NOT dropped by a message that did not ask for them: that
    // would turn a desync into a silent truncation, and idle() below is what
    // catches it.
    if (bin === undefined) return body;
    const held = this.held;
    this.held = null;
    if (!held || held.id !== bin) throw new WireError("the peer claimed a binary frame that did not arrive");
    const path = binaryPath(kind, method);
    if (!path) throw new WireError(`the peer sent bytes with ${kind}:${method}, which carries none`);
    return restoreBinary(body, path, held.bytes);
  }

  /** A control frame that claimed nothing leaves nothing held: bytes with no
   * claimant are a desync, not a spare. */
  idle(): boolean {
    return this.held === null;
  }
}
