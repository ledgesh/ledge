// The frame codec is the one piece of Ledge a machine on the other end of an
// ssh connection gets to feed bytes to (remote.md §4), so its failure modes
// are the interesting part: a length that lies, a type nobody defined, a frame
// that arrives one byte at a time. Everything here is values in and values
// out; the connection that uses it is transport.test.ts.
import { describe, expect, test } from "bun:test";
import {
  BINARY_FRAME,
  binaryPath,
  checkHello,
  CLIENT_PUSHES,
  CONTROL_FRAME,
  encodeBinary,
  encodeControl,
  fingerprint,
  FrameDecoder,
  hello,
  hoistBinary,
  MAX_FRAME_BYTES,
  needsOp,
  parseControl,
  PROTOCOL_VERSION,
  PUSH_MESSAGES,
  READ_ONLY_METHODS,
  REQUEST_METHODS,
  restoreBinary,
  SCHEMA_VERSION,
  sessionHold,
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
      { t: "ping" },
      { t: "pong" },
    ];
    for (const msg of all) expect(parseControl(JSON.stringify(msg))).toEqual(msg);
  });

  // The heartbeat carries nothing, so there is nothing on it for a peer to lie
  // about the size of — and whatever it does put there goes no further.
  test("a probe arrives with nothing on it, whatever the peer attached", () => {
    expect(parseControl('{"t":"ping","p":{"big":"payload"},"id":7}')).toEqual({ t: "ping" });
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

  // Two numbers under one name: what the client asks for, and the most the
  // server will do. Which is which is decided by the role, because the hellos
  // cross rather than answering each other.
  test("the ask and the ceiling ride the same field, one from each end", () => {
    expect(hello("client", "0.1.0", "abc-123", "", 300_000).hold).toBe(300_000);
    expect(hello("server", "0.1.0", "", "one-server", 600_000).hold).toBe(600_000);
    // And by default nobody asks and nobody offers: a desktop client is not
    // suspended out from under its connection, and has no reason to.
    expect(hello("client", "0.1.0").hold).toBe(0);
    expect(hello("server", "0.1.0").hold).toBe(0);
  });

  test("the hold survives the round trip", () => {
    const sent = hello("client", "0.1.0", "abc-123", "", 300_000);
    expect(parseControl(JSON.stringify(sent))).toEqual(sent);
  });

  // Absent is lenient for the same reason the client id is: a peer old enough
  // to omit it fails on the protocol version instead, which names both numbers.
  test("a hello with no hold asks for nothing", () => {
    expect(parseControl('{"t":"hello","role":"client","protocol":2,"schema":"a","build":"b"}')).toMatchObject({
      hold: 0,
    });
  });

  // Stricter than the two strings beside it, because this one is arithmetic
  // the server does on a number the client chose: NaN compares false against
  // everything, and the timer it reached would be armed for nothing.
  test.each([
    ["a string", '"soon"'],
    ["not a number", "null"],
    ["negative", "-1"],
    ["infinite", "1e999"],
  ])("a hold that is %s is refused", (_what, value) => {
    const text = `{"t":"hello","role":"client","protocol":2,"schema":"a","build":"b","hold":${value}}`;
    expect(() => parseControl(text)).toThrow(WireError);
  });

  // The readable half of who is connecting (remote.md §7). The id keys files;
  // this is what another client's chrome shows, which is why it is the one
  // string in the handshake that is cleaned rather than trusted or refused.
  test("a device's name for itself rides the handshake, and survives the round trip", () => {
    const sent = hello("client", "0.1.0", "abc-123", "", 0, "Studio");
    expect(sent.label).toBe("Studio");
    expect(parseControl(JSON.stringify(sent))).toEqual(sent);
  });

  test("a server names nobody, and a client may decline to", () => {
    expect(hello("server", "0.1.0", "", "one-server").label).toBe("");
    expect(hello("client", "0.1.0", "abc-123").label).toBe("");
    expect(checkHello(hello("client", "0.1.0", "abc-123"), "client")).toBeNull();
  });

  // Cleaned, not refused: hanging up on a phone over its device name would cost
  // a session to gain nothing, and every one of these reduces to something a
  // sidebar can hold.
  test.each([
    ["absent", undefined, ""],
    ["not a string", 7, ""],
    ["newlines", "Mac\nmini", "Mac mini"],
    ["escape sequences", "\u001b[31mred", "[31mred"],
    ["padded", "  Studio  ", "Studio"],
  ])("a label that is %s becomes %p", (_what, given, want) => {
    const text = JSON.stringify({ t: "hello", role: "client", protocol: 2, schema: "a", build: "b", label: given });
    expect(parseControl(text)).toMatchObject({ label: want });
  });

  // Bounded because the server keeps one per connection and pushes it to every
  // other client: a peer that chooses the length chooses what that costs.
  test("a label longer than the cap is cut, not refused", () => {
    const long = "n".repeat(500);
    const seen = parseControl(
      JSON.stringify({ t: "hello", role: "client", protocol: 2, schema: "a", build: "b", label: long }),
    ) as { label: string };
    expect(seen.label.length).toBe(64);
    // And the same rule on the way out, so a device with an unusable name
    // cannot send one to a server that predates the check.
    expect(hello("client", "0.1.0", "abc-123", "", 0, long).label.length).toBe(64);
  });
});

// The client names what it wants, the server names what it will do, and the
// term is the server's because the process being kept alive is the server's
// (remote.md §7, bun/daemon.ts HOLD_MAX_MS).
describe("the session hold", () => {
  test("an ask the server keeps that long is granted whole", () => {
    expect(sessionHold(300_000, 600_000)).toBe(300_000);
  });

  test("an absurd ask is clamped rather than refused", () => {
    expect(sessionHold(86_400_000, 600_000)).toBe(600_000);
  });

  // Both of the ways this ends up zero, and they mean the same thing to the
  // daemon: nothing here is worth keeping a process for.
  test("nothing offered and nothing asked both come to nothing", () => {
    expect(sessionHold(300_000, 0)).toBe(0);
    expect(sessionHold(0, 600_000)).toBe(0);
    expect(sessionHold(-1, 600_000)).toBe(0);
  });

  // The reason it is one function rather than a rule each end keeps: they
  // compute it from opposite sides of the same pair and must not disagree,
  // and no reply carries the answer back.
  test("both ends reach the same number without either being told", () => {
    const ASK = 300_000;
    const CEILING = 600_000;
    const fromServer = hello("server", "0.1.0", "", "one-server", CEILING);
    const fromClient = hello("client", "0.1.0", "phone-1", "", ASK);
    expect(sessionHold(ASK, fromServer.hold)).toBe(sessionHold(fromClient.hold, CEILING));
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

describe("which requests carry an op (remote.md §7)", () => {
  test("a read does not, because running it again is running it once", () => {
    expect(needsOp("noteRead")).toBe(false);
    expect(needsOp("noteSearch")).toBe(false);
    expect(needsOp("layoutGet")).toBe(false);
  });

  test("anything that changes something does", () => {
    expect(needsOp("noteWrite")).toBe(true);
    expect(needsOp("noteDelete")).toBe(true);
    expect(needsOp("terminalInput")).toBe(true);
    expect(needsOp("openRequestTake")).toBe(true);
    // It reads like a question and it is not one: an unclaimed run is
    // interrupted by the asking, so a replay must be answered from the record
    // rather than run again against whatever is going by then.
    expect(needsOp("inlineClaim")).toBe(true);
  });

  // The list is stated as the READS so that the default is to dedupe. A method
  // nobody classified costs an entry in a bounded window; the other default
  // costs a note written twice.
  test("a name nobody has classified is deduped rather than replayed blind", () => {
    expect(needsOp("somethingAddedNextYear")).toBe(true);
  });

  test("every read-only name is a real method", () => {
    for (const m of READ_ONLY_METHODS) expect(REQUEST_METHODS).toContain(m);
  });
});

describe("payloads that ride binary frames", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0xff, 0x00, 0x01]);

  test("a field is lifted out and put back exactly", () => {
    const path = binaryPath("push", "terminalOutput")!;
    expect(path).toEqual(["dataB64"]);
    const b64 = Buffer.from(bytes).toString("base64");
    const lifted = hoistBinary({ sessionId: "s", dataB64: b64 }, path)!;
    expect(lifted.payload).toEqual({ sessionId: "s", dataB64: "" });
    expect(lifted.bytes).toEqual(bytes);
    expect(restoreBinary(lifted.payload, path, lifted.bytes)).toEqual({ sessionId: "s", dataB64: b64 });
  });

  // assetRead answers `{image: null}` for a file that is not there, so the
  // path has to tolerate the object it points into being absent.
  test("a nested field that is not there lifts nothing", () => {
    const path = binaryPath("res", "assetRead")!;
    expect(hoistBinary({ image: null }, path)).toBeNull();
    expect(hoistBinary({ image: { dataB64: "", mime: "image/png" } }, path)).toBeNull();
    const lifted = hoistBinary({ image: { dataB64: "iVBORw==", mime: "image/png" } }, path)!;
    expect(lifted.payload).toEqual({ image: { dataB64: "", mime: "image/png" } });
  });

  // Every base64 that reaches hoistBinary was written by toBase64 a few lines
  // earlier: the pty drain loop's output, a file the server read, a paste the
  // client encoded. So a string that is not base64 is a bug in this codebase,
  // and the builtin refusing it is better than Buffer's old habit of decoding
  // the prefix and discarding the rest — which would have put SHORT bytes on
  // the wire and called it a success.
  test("a field that is not base64 is refused rather than truncated", () => {
    expect(() => hoistBinary({ sessionId: "s", dataB64: "not base64!" }, ["dataB64"])).toThrow();
  });

  test("the caller's payload is not mutated", () => {
    const original = { sessionId: "s", dataB64: "AAEC" };
    hoistBinary(original, ["dataB64"]);
    expect(original.dataB64).toBe("AAEC");
  });

  test("a method with no bulky field has no path", () => {
    expect(binaryPath("req", "noteWrite")).toBeNull();
    expect(binaryPath("push", "notesChanged")).toBeNull();
  });
});

describe("client-only pushes", () => {
  // The mirror of CLIENT_METHODS: a server has no business reporting the state
  // of a wire it is on the far side of, so the name is simply not in the list
  // the transport routes.
  test("connectionState never crosses the wire", () => {
    expect(CLIENT_PUSHES).toContain("connectionState");
    expect(PUSH_MESSAGES as readonly string[]).not.toContain("connectionState");
  });
});
