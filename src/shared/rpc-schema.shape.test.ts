// The tripwire under PROTOCOL_VERSION (remote.md §11).
//
// The handshake now refuses on exactly one thing: the protocol version. That
// works only if the version moves when a payload's shape moves, and nothing
// derives it. A person bumps it in the same commit that changed the shape. If
// they forget, two builds ship that read each other's bytes as something they
// are not. So this test asks in that commit, the only moment anyone can answer
// the question.
//
// It pins a digest of the schema's types. When they change it fails, and the
// failure is a fork:
//
//   - additive, or a rename nobody has shipped yet, or a comment reflowed:
//     nothing on the wire reads differently, so update PINNED below.
//   - a field removed, retyped, or made required; a union narrowed; a meaning
//     changed under a name that stayed: bump PROTOCOL_VERSION in wire.ts,
//     then update PINNED.
//
// The test cannot tell the two cases apart. A check that could would be a
// check that could derive the version. It makes someone decide.
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "./wire";

const SCHEMA = new URL("./rpc-schema.ts", import.meta.url).pathname;

/**
 * The schema's types, with everything that is not a type removed: comments go,
 * runs of whitespace collapse, blank lines go. Comments are stripped because
 * this schema is more prose than declaration. A digest that tripped on a
 * reflowed paragraph would get the pin updated without anyone reading the
 * diff. That is the failure a tripwire exists to prevent.
 */
function shapeOf(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\s+/g, " ")
      // A separator before a closing brace is punctuation the formatter chose,
      // not a field. Without this the digest would move when prettier's
      // trailing-comma setting does. The test would then report a shape change
      // that is not one: a diff nobody would read.
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
  // server ignores on noteCreate puts the note at the root, the placement
  // every create had before. A noteMove an old server does not implement is
  // refused by name at the handshake's method check, so the move fails rather
  // than landing somewhere wrong. Nothing was retyped, made required, or
  // narrowed. The pin moves and the version does not.
  //
  // Then the folder scope reached the two scans the overlay runs: noteSearch
  // and tagList each gained an optional `folder`. Additive again, and the
  // no-bump call is the same one noteCreate's `folder` got, for the same
  // reason. An old server ignores the field and answers over the whole
  // workspace: wider than the caller asked for, never something else. The hits
  // are real hits in real notes, so the answer is bigger than the question
  // rather than an answer to a different question. The narrowing is a
  // selection, not a placement: a `folder` the peer drops cannot put a byte
  // anywhere.
  //
  // Then folderRename. It is a new method, and so the easiest of the three
  // calls: noteMove's case exactly. A server that does not have it refuses it
  // by name at the handshake's method check, and the rename fails saying so:
  // loud, local, survivable (remote.md §11). A missing method needs no version
  // bump. folderRename changes no existing payload, and nothing else in the
  // schema was touched to add it.
  //
  // Then folderDelete. folderRename's argument applies to it word for word: a
  // new method, refused by name by a server that predates it, touching no
  // payload that already existed. It is not the half of deleting a folder that
  // touches the notes. What a peer of either age does to the notes is
  // `noteDelete`'s move into the trash, which both ends have always had, so an
  // old server cannot half-delete a folder.
  //
  // Then the favorite marker. NoteMeta gained an optional `favorite`, and
  // noteFavorite is a new method: folder's two calls again, and they land the
  // same way. A server that predates the method refuses it by name at the
  // handshake's method check, so favoriting fails loudly instead of writing
  // somewhere wrong, and a NoteMeta with no `favorite` reads as unmarked,
  // which is what every note on such a server is. Nothing was retyped, made
  // required, or narrowed. The pin moves and the version does not.
  // Then vaultChangePassphrase's response gained `error`. The sweep behind it
  // became all-or-nothing (locking.md §3), so a refusal now has a reason worth
  // showing, and the field carries it. Additive, and it degrades in both
  // directions: an old client ignores a field it does not read and keeps
  // printing its own "could not change the passphrase", while a new client
  // against an old server reads `undefined` and falls back to that same
  // sentence (VaultDialog's `??`). `ok` and `rewrapped` are untouched, so
  // neither end reads an existing field differently. What an old SERVER does
  // to the notes is the old sweep, which is a bug in that server and not a
  // disagreement between the two: the wire says the same thing either way.
  // Nothing was retyped, made required, or narrowed. The pin moves and the
  // version does not.
  const PINNED = { protocol: 5, shape: "62926ff60e100f76" };

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
