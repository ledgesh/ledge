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
  // Folders reached the note surfaces: NoteMeta gained an optional `folder`,
  // noteCreate gained an optional `folder` param, and noteMove is a new
  // method. All three are additive, and each degrades to today's behavior in
  // both directions. A NoteMeta with no `folder` reads as the top level, which
  // is where every note an old server holds actually is. A `folder` an old
  // server ignores on noteCreate puts the note at the root — the placement
  // every create had before. A noteMove an old server does not implement is
  // refused BY NAME at the handshake's method check, which surfaces as a
  // failed move rather than as a wrong one. Nothing was retyped, made
  // required, or narrowed. The pin moves and the version does not.
  //
  // Then the folder scope reached the two scans the overlay runs: noteSearch
  // and tagList each gained an optional `folder`. Additive again, and the
  // no-bump call is the same one noteCreate's `folder` got, for the same
  // reason. An old server ignores the field and answers over the whole
  // workspace: WIDER than asked, never other than asked — the hits are real
  // hits in real notes, which is the difference between an answer that is
  // bigger than the question and an answer to a different question. And the
  // narrowing is a selection, not a place: a `folder` the peer drops cannot
  // put a byte anywhere.
  //
  // Then folderRename, which is a NEW METHOD and so the easiest of the three
  // calls: it is noteMove's case exactly. A server that does not have it
  // refuses it by name at the handshake's method check, and the rename fails
  // saying so — loud, local, survivable (remote.md §11), which is the whole
  // reason a missing method is not on the version's list. It changes no
  // existing payload: nothing else in the schema was touched to add it.
  //
  // Then folderDelete, on folderRename's argument word for word — a new
  // method, refused by name by a server that predates it, touching no payload
  // that already existed. Worth saying once that it is not the interesting
  // half of deleting a folder: what a peer of either age does to the notes is
  // `noteDelete`'s move into the trash, which both ends have always had, so an
  // old server cannot half-delete a folder. It answers the whole call or none
  // of it.
  const PINNED = { protocol: 5, shape: "a51a2fc0e12f5890" };

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
