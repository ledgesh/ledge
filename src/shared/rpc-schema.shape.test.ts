// The tripwire under PROTOCOL_VERSION (remote.md §11).
//
// The handshake refuses on exactly one thing now: the protocol version. That
// is the right trade only if the version actually MOVES when a payload's shape
// does, and nothing derives it — a person bumps it, in the same commit that
// changed the shape, or forgets to and ships two builds that read each other's
// bytes as something they are not.
//
// So this test asks the question at the only moment anyone can answer it. It
// pins a digest of the schema's TYPES; when they change, it fails, and the
// failure is a fork:
//
//   - additive, or a rename nobody has shipped yet, or a comment reflowed:
//     nothing on the wire reads differently, so update PINNED below and move on.
//   - a field removed, retyped, or made required; a union narrowed; a meaning
//     changed under a name that stayed: bump PROTOCOL_VERSION in wire.ts, THEN
//     update PINNED.
//
// It cannot tell the two apart — that judgment is the point, and a machine that
// could make it would be a machine that could derive the version. What it can
// do is guarantee nobody is never asked.
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "./wire";

const SCHEMA = new URL("./rpc-schema.ts", import.meta.url).pathname;

/**
 * The schema's types, with everything that is not a type removed: comments go,
 * runs of whitespace collapse, blank lines go.
 *
 * Stripping comments is what makes this liveable rather than noise. This
 * codebase's schema is more prose than declaration, and a digest that tripped
 * on a reflowed paragraph would be answered by updating the pin without reading
 * the diff — which is the failure mode a tripwire exists to avoid.
 */
function shapeOf(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\s+/g, " ")
      // A separator before a closing brace is punctuation the formatter chose,
      // not a field. Without this the digest moves when prettier's trailing
      // comma setting does, which is a diff nobody would read.
      .replace(/\s*[;,]\s*}/g, " }")
      .trim()
  );
}

function digest(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

describe("the schema's shape against the protocol version", () => {
  // Bump PROTOCOL_VERSION first if the change is breaking; see the header.
  // noteStash was added: a new method, no existing payload touched. A client
  // that has it talking to a server that does not is refused at `supports`
  // before the round trip (remote.md §11), and the one caller keeps its buffer
  // rather than acting — so the two builds still read each other correctly.
  // Additive, therefore the pin moves and the version does not.
  const PINNED = { protocol: 5, shape: "d0e9c1c9bfe2eb7e" };

  test("a payload shape does not change without someone deciding whether it breaks", async () => {
    const shape = digest(shapeOf(await Bun.file(SCHEMA).text()));
    // The pin is seeded empty so the first run reports the digest to paste in
    // rather than failing on a number nobody has seen yet.
    if (PINNED.shape === "") {
      console.log(`[schema] no shape pinned yet; PINNED.shape should be "${shape}"`);
      return;
    }
    expect({ shape, protocol: PROTOCOL_VERSION }).toEqual({ shape: PINNED.shape, protocol: PINNED.protocol });
  });

  test("comments and reflowing are not shape changes", () => {
    const before = "interface A { /** the id */ id: string; // trailing\n b: number }";
    const after = "interface A {\n  /**\n   * the id, at length\n   */\n  id: string;\n  b: number;\n}";
    expect(digest(shapeOf(before))).toBe(digest(shapeOf(after)));
  });

  test("a retyped field is", () => {
    expect(digest(shapeOf("interface A { id: string }"))).not.toBe(digest(shapeOf("interface A { id: number }")));
  });

  test("an optional marker is", () => {
    expect(digest(shapeOf("interface A { id: string }"))).not.toBe(digest(shapeOf("interface A { id?: string }")));
  });

  // The URL in a comment is the case the naive `//` strip gets wrong, and there
  // are several in the schema.
  test("a url in a comment does not survive as shape", () => {
    expect(shapeOf("// see https://example.com/x\ninterface A { id: string }")).toBe("interface A { id: string }");
  });
});
