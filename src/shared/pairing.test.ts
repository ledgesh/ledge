// The pairing code's TypeScript half (remote.md §4b). The vectors are the rules
// both readers answer to; pairing.swift.test.ts runs the phone's reader over
// the same file.
import { describe, expect, test } from "bun:test";
import { PORT_UNSET } from "./connections";
import { codeForRecord, PAIRING_PROBLEMS, pairingLink, pairingProblem, parsePairingLink, type PairingCode } from "./pairing";
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

// The code a Mac shows for a server it has (remote.md §4b): the record and its
// pin, and nothing dialled.
describe("the code for a record", () => {
  const FP = "SHA256:TC7eh5uTmsVcxQYnqmYU91fK88ypYrcXOZYJ2Je8i7w";
  const vps = { name: "VPS", destination: "ledge@vps.example", port: PORT_UNSET, fingerprint: FP, keyType: "ED25519" };

  test("names the account, the host, the port and the pinned key", () => {
    expect(codeForRecord(vps)).toEqual({ code: { user: "ledge", host: "vps.example", port: PORT_UNSET, fingerprints: [FP] } });
    expect(codeForRecord({ ...vps, port: 2222, keyType: "ECDSA" })).toEqual({
      code: { user: "ledge", host: "vps.example", port: 2222, fingerprints: [FP] },
    });
  });

  test("stores port 22 as the default, as a read code does", () => {
    expect(codeForRecord({ ...vps, port: 22 })).toEqual(codeForRecord(vps));
  });

  test("a record with no pin has nothing for a code to name", () => {
    const made = codeForRecord({ ...vps, fingerprint: "", keyType: "" });
    expect("problem" in made && made.problem).toContain("No host key is pinned for \"VPS\"");
    expect("problem" in made && made.problem).toContain("Check Key Again");
  });

  test("a pin a phone cannot check is refused, naming the key type", () => {
    const made = codeForRecord({ ...vps, keyType: "RSA" });
    expect("problem" in made && made.problem).toContain("an RSA host key");
    expect("problem" in made && made.problem).toContain("Ed25519 and ECDSA");
  });

  test("a destination that leaves the account to ssh cannot become a code", () => {
    const made = codeForRecord({ ...vps, destination: "vps" });
    expect("problem" in made && made.problem).toContain("user@host");
  });

  test("a host a code cannot carry is refused in the record's terms", () => {
    const made = codeForRecord({ ...vps, destination: "ledge@[fd7a::1]" });
    expect("problem" in made && made.problem).toContain("IPv4");
    const user = codeForRecord({ ...vps, destination: "-oProxyCommand=sh@vps" });
    expect("problem" in user && user.problem).toContain("account name");
  });

  test("the code it makes is the one a reader gets back", () => {
    const made = codeForRecord({ ...vps, port: 2222 }) as { code: PairingCode };
    expect(parsePairingLink(pairingLink(made.code))).toEqual(made);
  });
});
