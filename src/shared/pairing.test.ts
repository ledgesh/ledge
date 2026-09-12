// The pairing code's TypeScript half (remote.md §4b). The vectors are the rules
// both readers answer to; pairing.swift.test.ts runs the phone's reader over
// the same file.
import { describe, expect, test } from "bun:test";
import { PORT_UNSET } from "./connections";
import { PAIRING_PROBLEMS, pairingLink, pairingProblem, parsePairingLink, type PairingCode } from "./pairing";
import vectorFile from "./pairing.vectors.json";

type Vector = { name: string; link: string; canonical?: boolean; code?: PairingCode; problem?: string };
const vectors: Vector[] = vectorFile.vectors;

describe("reading a link", () => {
  test.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    expect(parsePairingLink(vector.link)).toEqual(vector.code ? { code: vector.code } : { problem: vector.problem! });
  });

  test("every vector expects a code or a problem, not both", () => {
    for (const vector of vectors) expect(vector.code === undefined).toBe(vector.problem !== undefined);
  });
});

describe("making a link", () => {
  test.each(vectors.filter((v) => v.canonical).map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    expect(pairingLink(vector.code!)).toBe(vector.link);
  });

  const code: PairingCode = {
    user: "dan",
    host: "atlas.example.net",
    port: PORT_UNSET,
    fingerprints: ["SHA256:K1zgEabMVuIGb180Vgx5Kkpx+lGxkA5qoH6h9KU4iTE"],
  };

  test("a link reads back as the code it was made from", () => {
    for (const port of [PORT_UNSET, 2222, 65535]) {
      expect(parsePairingLink(pairingLink({ ...code, port }))).toEqual({ code: { ...code, port } });
    }
  });

  test("port 22 is written as no port at all", () => {
    expect(pairingLink({ ...code, port: 22 })).toBe(pairingLink(code));
  });

  test("a host key given twice is written once", () => {
    const twice = { ...code, fingerprints: [code.fingerprints[0]!, code.fingerprints[0]!] };
    expect(pairingLink(twice)).toBe(pairingLink(code));
  });

  test("a code the reader would refuse is refused before it becomes a link", () => {
    const bad = { ...code, user: "-oProxyCommand=sh" };
    expect(pairingProblem(bad)).toBe(PAIRING_PROBLEMS.user);
    expect(() => pairingLink(bad)).toThrow(PAIRING_PROBLEMS.user);
  });

  // The fields are credential-free by construction: there is nowhere to put one.
  test("a code has no field beyond the account, host, port and host keys", () => {
    const read = parsePairingLink(pairingLink(code)) as { code: PairingCode };
    expect(Object.keys(read.code).sort()).toEqual(["fingerprints", "host", "port", "user"]);
  });
});
