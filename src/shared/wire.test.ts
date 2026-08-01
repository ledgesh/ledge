// The frame codec is the one piece of Ledge a machine on the other end of an
// ssh connection gets to feed bytes to (remote.md §4), so its failure modes
// are the interesting part: a length that lies, a type nobody defined, a frame
// that arrives one byte at a time. Everything here is values in and values
// out; the connection that uses it is transport.test.ts.
import { describe, expect, test } from "bun:test";
import {
  BINARY_FRAME,
  checkHello,
  CONTROL_FRAME,
  encodeBinary,
  encodeControl,
  fingerprint,
  FrameDecoder,
  hello,
  MAX_FRAME_BYTES,
  parseControl,
  PROTOCOL_VERSION,
  PUSH_MESSAGES,
  REQUEST_METHODS,
  SCHEMA_VERSION,
  WireError,
  type Frame,
  type WireMessage,
} from "./wire";

function decodeAll(chunks: Uint8Array[]): Frame[] {
  const decoder = new FrameDecoder();
  return chunks.flatMap((c) => decoder.push(c));
}

function textOf(frame: Frame | undefined): string {
  if (!frame || frame.type !== CONTROL_FRAME) throw new Error("expected a control frame");
  return frame.text;
}

const REQ: WireMessage = { t: "req", id: 7, m: "noteRead", p: { path: "/notes/a.md" } };

describe("framing", () => {
  test("a control frame round trips", () => {
    const [frame, ...rest] = decodeAll([encodeControl(REQ)]);
    expect(rest).toEqual([]);
    expect(parseControl(textOf(frame))).toEqual(REQ);
  });

  test("a frame is 4 length bytes big-endian, then the type, then the payload", () => {
    const bytes = encodeControl({ t: "bye", why: "x" });
    const payload = JSON.stringify({ t: "bye", why: "x" });
    expect(bytes.length).toBe(5 + payload.length);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0, 0, 0]);
    expect(bytes[3]).toBe(payload.length);
    expect(bytes[4]).toBe(CONTROL_FRAME);
  });

  test("several frames arriving in one chunk all come out", () => {
    const a = encodeControl(REQ);
    const b = encodeControl({ t: "res", id: 7, r: null });
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0);
    both.set(b, a.length);
    const frames = decodeAll([both]);
    expect(frames.length).toBe(2);
    expect(parseControl(textOf(frames[1]))).toEqual({ t: "res", id: 7, r: null });
  });

  // The one property a pipe guarantees nothing about. A frame split anywhere
  // has to survive, so it is split everywhere.
  test("a frame split at any byte boundary still arrives whole", () => {
    const bytes = encodeControl(REQ);
    for (let at = 0; at <= bytes.length; at++) {
      const frames = decodeAll([bytes.slice(0, at), bytes.slice(at)]);
      expect(parseControl(textOf(frames[0]))).toEqual(REQ);
      expect(frames.length).toBe(1);
    }
  });

  test("a frame arriving one byte at a time still arrives whole", () => {
    const bytes = encodeControl(REQ);
    const decoder = new FrameDecoder();
    const out: Frame[] = [];
    for (const b of bytes) out.push(...decoder.push(new Uint8Array([b])));
    expect(out.length).toBe(1);
    expect(parseControl(textOf(out[0]))).toEqual(REQ);
  });

  test("a header alone yields nothing and does not lose the frame behind it", () => {
    const bytes = encodeControl(REQ);
    const decoder = new FrameDecoder();
    expect(decoder.push(bytes.slice(0, 5))).toEqual([]);
    expect(decoder.push(bytes.slice(5)).length).toBe(1);
  });

  test("multi-byte characters survive a split through the middle of one", () => {
    const msg: WireMessage = { t: "push", m: "notesChanged", p: { root: "/notes/📓 ünïcode" } };
    const bytes = encodeControl(msg);
    const frames = decodeAll([bytes.slice(0, bytes.length - 3), bytes.slice(bytes.length - 3)]);
    expect(parseControl(textOf(frames[0]))).toEqual(msg);
  });

  test("a binary frame carries the id of the control frame it belongs to", () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const [frame] = decodeAll([encodeBinary(66000, bytes)]);
    expect(frame?.type).toBe(BINARY_FRAME);
    if (frame?.type !== BINARY_FRAME) throw new Error("unreachable");
    expect(frame.id).toBe(66000);
    expect([...frame.bytes]).toEqual([1, 2, 3, 250]);
  });

  test("a binary frame's bytes are the caller's own, not a view into the decoder", () => {
    const decoder = new FrameDecoder();
    const [frame] = decoder.push(encodeBinary(1, new Uint8Array([9, 9])));
    if (frame?.type !== BINARY_FRAME) throw new Error("expected a binary frame");
    decoder.push(encodeBinary(2, new Uint8Array([0, 0])));
    expect([...frame.bytes]).toEqual([9, 9]);
  });

  // The cap is the whole reason a hostile length is not a memory bug, so it
  // has to be refused on the header, before a single payload byte is held.
  test("an announced length over the cap is refused before its bytes arrive", () => {
    const header = new Uint8Array(5);
    const huge = MAX_FRAME_BYTES + 1;
    header[0] = (huge >>> 24) & 0xff;
    header[1] = (huge >>> 16) & 0xff;
    header[2] = (huge >>> 8) & 0xff;
    header[3] = huge & 0xff;
    header[4] = CONTROL_FRAME;
    expect(() => new FrameDecoder().push(header)).toThrow(WireError);
  });

  test("a length with the high bit set is a huge frame, not a negative one", () => {
    const header = new Uint8Array([0xff, 0xff, 0xff, 0xff, CONTROL_FRAME]);
    expect(() => new FrameDecoder().push(header)).toThrow(/4294967295-byte frame/);
  });

  test("a frame type nobody defined is refused", () => {
    const bytes = encodeControl(REQ);
    bytes[4] = 9;
    expect(() => new FrameDecoder().push(bytes)).toThrow(/unknown type 9/);
  });

  test("a binary frame too short to hold an id is refused", () => {
    const bytes = new Uint8Array([0, 0, 0, 2, BINARY_FRAME, 1, 2]);
    expect(() => new FrameDecoder().push(bytes)).toThrow(WireError);
  });

  test("an empty payload is a legal frame and an illegal message", () => {
    const empty = new Uint8Array([0, 0, 0, 0, CONTROL_FRAME]);
    const [frame] = decodeAll([empty]);
    expect(textOf(frame)).toBe("");
    expect(() => parseControl("")).toThrow(WireError);
  });
});

describe("control messages", () => {
  test("every message type round trips", () => {
    const all: WireMessage[] = [
      hello("client", "0.1.0"),
      { t: "req", id: 0, m: "vaultState", p: {} },
      { t: "res", id: 1, r: { state: "locked" } },
      { t: "err", id: 2, e: "outside the workspace roots" },
      { t: "push", m: "vaultChanged", p: { state: "locked" } },
      { t: "bye", why: "protocol version 2 on the client, 1 here" },
    ];
    for (const msg of all) expect(parseControl(JSON.stringify(msg))).toEqual(msg);
  });

  // The peer chose every byte of this, so the checks are at the boundary or
  // they are nowhere (remote.md §2).
  test.each([
    ["not JSON at all", "{"],
    ["a bare number", "42"],
    ["null", "null"],
    ["an array", "[]"],
    ["a type nobody defined", '{"t":"hack"}'],
    ["no type at all", "{}"],
    ["a request with no method", '{"t":"req","id":1}'],
    ["a request with no id", '{"t":"req","m":"noteRead"}'],
    ["a request whose id is a string", '{"t":"req","id":"1","m":"noteRead"}'],
    ["a request whose id is negative", '{"t":"req","id":-1,"m":"noteRead"}'],
    ["a request whose id is fractional", '{"t":"req","id":1.5,"m":"noteRead"}'],
    ["a response with no id", '{"t":"res","r":1}'],
    ["an error with no message", '{"t":"err","id":1}'],
    ["a push with no message name", '{"t":"push","p":{}}'],
    ["a hello with no role", '{"t":"hello","protocol":1,"schema":"a","build":"b"}'],
    ["a hello claiming to be neither end", '{"t":"hello","role":"proxy","protocol":1,"schema":"a","build":"b"}'],
    ["a hello with no protocol version", '{"t":"hello","role":"server","schema":"a","build":"b"}'],
    ["a hello with no schema version", '{"t":"hello","role":"server","protocol":1,"build":"b"}'],
  ])("%s is refused", (_what, text) => {
    expect(() => parseControl(text)).toThrow(WireError);
  });

  // The only field allowed to be missing: a hangup with no stated reason is
  // still a hangup, and refusing it would mean losing the close.
  test("a bye with no reason is accepted and says so", () => {
    expect(parseControl('{"t":"bye"}')).toEqual({ t: "bye", why: "no reason given" });
  });

  test("unknown extra fields are dropped rather than carried through", () => {
    expect(parseControl('{"t":"res","id":3,"r":1,"extra":"ignored"}')).toEqual({ t: "res", id: 3, r: 1 });
  });
});

describe("the handshake", () => {
  test("a matching peer is accepted", () => {
    expect(checkHello(hello("server", "0.1.0"), "server")).toBeNull();
  });

  test("a peer on the other side of the connection than expected is refused", () => {
    expect(checkHello(hello("client", "0.1.0"), "server")).toContain("says it is a client");
  });

  // "Incompatible" with no numbers in it is a message nobody can act on.
  test("a protocol mismatch names both versions", () => {
    const refusal = checkHello({ ...hello("server", "0.1.0"), protocol: 99 }, "server");
    expect(refusal).toContain("99");
    expect(refusal).toContain(String(PROTOCOL_VERSION));
  });

  test("a schema mismatch names both fingerprints and the peer's build", () => {
    const refusal = checkHello({ ...hello("server", "9.9.9"), schema: "deadbeef" }, "server");
    expect(refusal).toContain("deadbeef");
    expect(refusal).toContain(SCHEMA_VERSION);
    expect(refusal).toContain("9.9.9");
  });

  // Deliberately not a refusal: differing builds are what the upgrade offer
  // reads (remote.md §11), and refusing them would make every version bump a
  // hard stop.
  test("a differing build alone is not a refusal", () => {
    expect(checkHello(hello("server", "0.2.0"), "server")).toBeNull();
  });

  // Identity rides the handshake rather than each request (remote.md §5): the
  // server files this client's layout under it, and a client cannot forget to
  // send something the connection carries for it.
  test("a client names itself, and a server names nobody", () => {
    expect(hello("client", "0.1.0", "abc-123").client).toBe("abc-123");
    expect(hello("server", "0.1.0").client).toBe("");
  });

  test("the id survives the round trip", () => {
    const sent = hello("client", "0.1.0", "abc-123");
    expect(parseControl(JSON.stringify(sent))).toEqual(sent);
  });

  // Not a refusal on its own: a peer old enough to omit the field fails on the
  // protocol version instead, which names both numbers and is the message
  // worth showing. An id of the wrong TYPE is still garbage and is refused.
  test("a hello with no client reads as no id; a non-string one is refused", () => {
    expect(parseControl('{"t":"hello","role":"client","protocol":2,"schema":"a","build":"b"}')).toMatchObject({
      client: "",
    });
    expect(() => parseControl('{"t":"hello","role":"client","protocol":2,"schema":"a","build":"b","client":7}')).toThrow(
      WireError,
    );
  });

  // A client that keeps no id is a client with no layout of its own, not a
  // client that cannot connect.
  test("an empty id is accepted", () => {
    expect(checkHello(hello("client", "0.1.0", ""), "client")).toBeNull();
  });
});

describe("the schema fingerprint", () => {
  test("it is eight hex digits", () => {
    expect(SCHEMA_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });

  test("reordering the list is not a schema change", () => {
    expect(fingerprint(["b", "a"])).toBe(fingerprint(["a", "b"]));
  });

  test("renaming, adding, or removing a method is", () => {
    const base = fingerprint(["a", "b"]);
    expect(fingerprint(["a", "c"])).not.toBe(base);
    expect(fingerprint(["a", "b", "c"])).not.toBe(base);
    expect(fingerprint(["a"])).not.toBe(base);
  });

  // A request and a push could one day share a name; the fingerprint must not
  // read the pair as unchanged when one moves to the other.
  test("a request and a push of the same name fingerprint differently", () => {
    expect(fingerprint(["req:x"])).not.toBe(fingerprint(["push:x"]));
  });

  // The lists are checked against the schema at COMPILE time in both
  // directions (wire.ts); these are the properties a type cannot state.
  test("the method lists have no duplicates", () => {
    expect(new Set(REQUEST_METHODS).size).toBe(REQUEST_METHODS.length);
    expect(new Set(PUSH_MESSAGES).size).toBe(PUSH_MESSAGES.length);
  });
});
