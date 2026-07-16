import { test, expect, describe } from "bun:test";
import { MarkerParser } from "./markers";

const NONCE = "testnonce";
const enc = new TextEncoder();
const dec = new TextDecoder();

// Raw OSC 133 markers as the shell would emit them (see markerCommand).
const begin = (id: string, nonce = NONCE) => enc.encode(`\x1b]133;C;ledge=${nonce}:${id}\x07`);
const end = (id: string, code = 0, nonce = NONCE) => enc.encode(`\x1b]133;D;${code};ledge=${nonce}:${id}\x07`);
const bytes = (s: string) => enc.encode(s);

// Concatenate byte chunks, mirroring a single PTY read.
function join(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// The text of every "output" event, concatenated.
function outputText(events: ReturnType<MarkerParser["feed"]>): string {
  return events
    .filter((e) => e.type === "output")
    .map((e) => dec.decode((e as { data: Uint8Array }).data))
    .join("");
}

describe("MarkerParser", () => {
  test("slices a full begin/output/end stream", () => {
    const p = new MarkerParser(NONCE);
    const events = p.feed(join(begin("1"), bytes("hello world"), end("1", 0)));
    expect(events.map((e) => e.type)).toEqual(["began", "output", "ended"]);
    expect(outputText(events)).toBe("hello world");
    expect(events[0]).toMatchObject({ type: "began", blockId: "1" });
    expect(events[2]).toMatchObject({ type: "ended", blockId: "1", exitCode: 0 });
  });

  test("propagates a non-zero exit code", () => {
    const p = new MarkerParser(NONCE);
    const events = p.feed(join(begin("1"), bytes("boom"), end("1", 3)));
    expect(events[events.length - 1]).toMatchObject({ type: "ended", blockId: "1", exitCode: 3 });
  });

  test("drops output emitted outside any block (prompt / echo noise)", () => {
    const p = new MarkerParser(NONCE);
    expect(p.feed(bytes("user@host % "))).toEqual([]);
  });

  test("accepts the ST (ESC-backslash) terminator as well as BEL", () => {
    const p = new MarkerParser(NONCE);
    const beginST = enc.encode(`\x1b]133;C;ledge=${NONCE}:1\x1b\\`);
    const events = p.feed(join(beginST, bytes("x"), end("1", 0)));
    expect(events.map((e) => e.type)).toEqual(["began", "output", "ended"]);
    expect(outputText(events)).toBe("x");
  });

  test("output arriving in several reads is emitted per read, in order", () => {
    const p = new MarkerParser(NONCE);
    const e1 = p.feed(begin("1"));
    const e2 = p.feed(bytes("aaa"));
    const e3 = p.feed(bytes("bbb"));
    const e4 = p.feed(end("1", 0));
    expect(e1.map((e) => e.type)).toEqual(["began"]);
    expect(outputText(e2)).toBe("aaa");
    expect(outputText(e3)).toBe("bbb");
    expect(e4.map((e) => e.type)).toEqual(["ended"]);
  });

  test("a marker split across two reads is buffered until complete", () => {
    const p = new MarkerParser(NONCE);
    const b = begin("42");
    const cut = 4; // mid-prefix
    const first = p.feed(b.subarray(0, cut));
    expect(first).toEqual([]); // nothing unambiguous yet
    const second = p.feed(join(b.subarray(cut), bytes("out"), end("42", 0)));
    expect(second.map((e) => e.type)).toEqual(["began", "output", "ended"]);
    expect(second[0]).toMatchObject({ blockId: "42" });
    expect(outputText(second)).toBe("out");
  });

  test("ignores markers whose nonce is not ours, and drops their output", () => {
    const p = new MarkerParser(NONCE);
    // A foreign begin (wrong nonce) must not open a block, so text after it is
    // treated as out-of-block noise and dropped.
    const events = p.feed(join(begin("1", "othernonce"), bytes("secret")));
    expect(events).toEqual([]);
  });

  test("only the output between C and D is kept, not surrounding noise", () => {
    const p = new MarkerParser(NONCE);
    const events = p.feed(
      join(bytes("prompt% "), begin("1"), bytes("real output"), end("1", 0), bytes("next prompt% ")),
    );
    expect(outputText(events)).toBe("real output");
  });

  test("handles two blocks back to back", () => {
    const p = new MarkerParser(NONCE);
    const events = p.feed(
      join(begin("a"), bytes("A"), end("a", 0), begin("b"), bytes("B"), end("b", 1)),
    );
    expect(events.map((e) => e.type)).toEqual([
      "began",
      "output",
      "ended",
      "began",
      "output",
      "ended",
    ]);
    const ids = events.map((e) => e.blockId);
    expect(ids).toEqual(["a", "a", "a", "b", "b", "b"]);
    expect(events[5]).toMatchObject({ type: "ended", blockId: "b", exitCode: 1 });
  });
});
