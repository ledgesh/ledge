// The wire between a Ledge client and a Ledge server (remote.md §3).
//
// Both ends speak it and neither owns it, which is why it sits in shared/:
// bun/transport.ts implements it over a child process's pipes today and an
// ssh child tomorrow, and an iOS client reimplements it in Swift with this
// file as the spec. Nothing here does I/O — it turns bytes into messages and
// back, and that is all.
//
// A frame is a 4-byte big-endian length, a 1-byte type, then that many bytes
// of payload. Type 0 is a JSON control frame: requests, responses, and the
// schema's push messages. Type 1 is a binary payload whose first 4 bytes are
// the id of the control frame it belongs to. Nothing sends a type-1 frame yet
// (assets and terminal output still ride base64 inside JSON, which was free
// in-process and costs 33% on a cell connection, remote.md §12); it is defined
// now because a header is the part of a wire format you cannot change later,
// and moving those payloads onto it should not be a protocol break.
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
export const PROTOCOL_VERSION = 2;

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
}

/**
 * Every control frame. `id` correlates a response with its request and nothing
 * else: frames are interleaved freely, so a slow search does not hold up the
 * keystroke behind it.
 */
export type WireMessage =
  | Hello
  // A client asking the server to run one of the schema's request handlers.
  | { t: "req"; id: number; m: string; p: unknown }
  | { t: "res"; id: number; r: unknown }
  // A handler that threw. Only the message travels: a stack trace names the
  // server's own paths, and the view has never had one.
  | { t: "err"; id: number; e: string }
  // One of the schema's webview messages, server to client, unsolicited.
  | { t: "push"; m: string; p: unknown }
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
  "terminalInput",
  "terminalPaste",
  "terminalResize",
  "terminalAttach",
  "terminalDetach",
  "terminalStatus",
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
  "connectionList",
  "connectionSelect",
  "connectionAdd",
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
  "notesChanged",
  "openExternal",
  "vaultChanged",
  "menuCommand",
] as const satisfies readonly PushMessage[];

// Exhaustiveness, in the direction `satisfies` cannot see. It refuses a name
// the schema does not have; these refuse a schema name the lists do not have,
// and the compiler's error is the missing method's own name. Between them,
// adding to rpc-schema.ts without adding here does not build.
type MissingRequest = Exclude<RequestMethod, (typeof REQUEST_METHODS)[number]>;
type MissingPush = Exclude<PushMessage, (typeof PUSH_MESSAGES)[number]>;
const everyRequestListed: MissingRequest extends never ? true : MissingRequest = true;
const everyPushListed: MissingPush extends never ? true : MissingPush = true;
void everyRequestListed;
void everyPushListed;

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

export function hello(role: "client" | "server", build: string, client = ""): Hello {
  return { t: "hello", role, protocol: PROTOCOL_VERSION, schema: SCHEMA_VERSION, build, client };
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
      return {
        t: "hello",
        role: m["role"],
        protocol: m["protocol"],
        schema: m["schema"],
        build: m["build"],
        client: typeof m["client"] === "string" ? m["client"] : "",
      };
    case "req":
      if (!isId(m["id"]) || typeof m["m"] !== "string") return bad("a request with no id or method");
      return { t: "req", id: m["id"], m: m["m"], p: m["p"] };
    case "res":
      if (!isId(m["id"])) return bad("a response with no id");
      return { t: "res", id: m["id"], r: m["r"] };
    case "err":
      if (!isId(m["id"]) || typeof m["e"] !== "string") return bad("an error with no id or message");
      return { t: "err", id: m["id"], e: m["e"] };
    case "push":
      if (typeof m["m"] !== "string") return bad("a push with no message name");
      return { t: "push", m: m["m"], p: m["p"] };
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
