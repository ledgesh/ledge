import { describe, expect, test } from "bun:test";
import { encode } from "uqr";
import { PORT_UNSET } from "../shared/connections";
import { PAIRING_PROBLEMS, pairingLink, type PairingCode } from "../shared/pairing";
import {
  CONTAINER_COMMAND,
  containerRefusal,
  pairAddress,
  pairCode,
  pairReport,
  parsePairArgs,
  phoneHostKeys,
  QR_OPTIONS,
  sshServerAddress,
  terminalQR,
  terminalQRWidth,
} from "./pair";

const ED25519 = "SHA256:TC7eh5uTmsVcxQYnqmYU91fK88ypYrcXOZYJ2Je8i7w";
const ECDSA = "SHA256:K1zgEabMVuIGb180Vgx5Kkpx+lGxkA5qoH6h9KU4iTE";
const RSA = "SHA256:Sk3/CKiRSuik41/ZQkJnKQVOw7uSKXcYiVPXvXCo5IE";

const CODE: PairingCode = { user: "dan", host: "atlas.example.net", port: 2222, fingerprints: [ED25519, ECDSA] };
const KEYS = [
  { fingerprint: ED25519, keyType: "ED25519" },
  { fingerprint: ECDSA, keyType: "ECDSA" },
];

const stripColor = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("parsePairArgs", () => {
  test("a flag takes its value from the next argument or after an equals sign", () => {
    expect(parsePairArgs(["--user", "dan", "--host=atlas", "--port", "2222", "--keys=-"])).toEqual({
      user: "dan",
      host: "atlas",
      port: "2222",
      keys: "-",
    });
  });

  test("no flags is no overrides", () => {
    expect(parsePairArgs([])).toEqual({});
  });

  test("an unknown flag or a bare word is refused by name", () => {
    expect(parsePairArgs(["--name", "x"])).toEqual({ error: 'pair does not take "--name".' });
    expect(parsePairArgs(["atlas"])).toEqual({ error: 'pair does not take "atlas".' });
  });

  test("a flag with no value is refused, whether last or given as an empty equals", () => {
    expect(parsePairArgs(["--host"])).toEqual({ error: "--host needs a value." });
    expect(parsePairArgs(["--user="])).toEqual({ error: "--user needs a value." });
  });
});

describe("sshServerAddress", () => {
  test("the server's IPv4 address and port come from the third and fourth fields", () => {
    expect(sshServerAddress("198.51.100.4 51234 203.0.113.7 2222")).toEqual({ host: "203.0.113.7", port: 2222 });
  });

  test("port 22 is stored as the default port", () => {
    expect(sshServerAddress("198.51.100.4 51234 203.0.113.7 22")).toEqual({ host: "203.0.113.7", port: PORT_UNSET });
  });

  test("an IPv4-mapped IPv6 address is read as the IPv4 address", () => {
    expect(sshServerAddress("::ffff:198.51.100.4 51234 ::ffff:203.0.113.7 22")?.host).toBe("203.0.113.7");
  });

  test("loopback, IPv6, a missing variable and a malformed one give no address", () => {
    expect(sshServerAddress("127.0.0.1 51234 127.0.0.1 22")).toBeNull();
    expect(sshServerAddress("fd7a::1 51234 fd7a::2 22")).toBeNull();
    expect(sshServerAddress(undefined)).toBeNull();
    expect(sshServerAddress("203.0.113.7 22")).toBeNull();
    expect(sshServerAddress("198.51.100.4 51234 203.0.113.7 ssh")).toBeNull();
  });
});

describe("pairAddress", () => {
  const SESSION = "198.51.100.4 51234 203.0.113.7 2222";

  test("with no flags and no ssh session, the machine's name on the default port", () => {
    expect(pairAddress({}, undefined, "atlas.local")).toEqual({ host: "atlas.local", port: PORT_UNSET, hostFrom: "name" });
  });

  test("an ssh session's address wins over the machine's name", () => {
    expect(pairAddress({}, SESSION, "atlas.local")).toEqual({ host: "203.0.113.7", port: 2222, hostFrom: "ssh" });
  });

  test("--host wins over the session's address and keeps the session's port", () => {
    expect(pairAddress({ host: "atlas.tail1234.ts.net" }, SESSION, "atlas")).toEqual({
      host: "atlas.tail1234.ts.net",
      port: 2222,
      hostFrom: "flag",
    });
  });

  test("--port wins over the session's port, and --port 22 is the default port", () => {
    expect(pairAddress({ port: "2200" }, SESSION, "atlas")).toMatchObject({ port: 2200 });
    expect(pairAddress({ port: "22" }, SESSION, "atlas")).toMatchObject({ port: PORT_UNSET });
  });

  test("a --port that is not a port is refused", () => {
    expect(pairAddress({ port: "22x" }, undefined, "atlas")).toEqual({ error: '"22x" is not a port from 1 to 65535.' });
    expect(pairAddress({ port: "0" }, undefined, "atlas")).toHaveProperty("error");
  });
});

describe("phoneHostKeys", () => {
  test("only Ed25519 and ECDSA keys are kept, Ed25519 first", () => {
    const output = [
      `256 ${ECDSA} root@atlas (ECDSA)`,
      `3072 ${RSA} root@atlas (RSA)`,
      `256 ${ED25519} root@atlas (ED25519)`,
    ].join("\n");
    expect(phoneHostKeys(output)).toEqual(KEYS);
  });

  test("a comment with spaces, no comment, and keyscan's host comment all parse", () => {
    const output = [`256 ${ED25519} no comment (ED25519)`, `256 ${ECDSA} [atlas]:2222 (ECDSA)`].join("\n");
    expect(phoneHostKeys(output)).toEqual(KEYS);
    expect(phoneHostKeys(`256 ${ED25519} (ED25519)`)).toEqual([KEYS[0]!]);
  });

  test("the same key given twice is listed once", () => {
    expect(phoneHostKeys(`256 ${ED25519} a (ED25519)\n256 ${ED25519} b (ED25519)`)).toEqual([KEYS[0]!]);
  });

  test("ssh-keygen's complaints and MD5 fingerprints are not keys", () => {
    expect(phoneHostKeys("(stdin) is not a public key file.\n256 MD5:16:27:ac:a5 a (ED25519)\n")).toEqual([]);
  });
});

describe("containerRefusal", () => {
  test("a container needs the account, the address and the keys from the host", () => {
    expect(containerRefusal({ user: "dan", host: "atlas" })).toContain(CONTAINER_COMMAND);
    expect(containerRefusal({ keys: "-" })).toContain(CONTAINER_COMMAND);
  });

  test("with all three given, a container is no obstacle", () => {
    expect(containerRefusal({ user: "dan", host: "atlas", keys: "-" })).toBeNull();
  });
});

describe("terminalQR", () => {
  const link = pairingLink(CODE);

  test("the half blocks read back as exactly the library's modules", () => {
    const { data, size } = encode(link, QR_OPTIONS);
    const modules: boolean[][] = Array.from({ length: size }, () => []);
    terminalQR(link).forEach((line, row) => {
      for (const glyph of stripColor(line)) {
        modules[row * 2]!.push(glyph === "█" || glyph === "▀");
        if (row * 2 + 1 < size) modules[row * 2 + 1]!.push(glyph === "█" || glyph === "▄");
      }
    });
    expect(modules).toEqual(data);
  });

  test("every line is dark on light and resets the color at its end", () => {
    for (const line of terminalQR(link)) {
      expect(line.startsWith("\x1b[30;107m")).toBe(true);
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });

  test("the quiet zone is four modules of light on every side", () => {
    const lines = terminalQR(link).map(stripColor);
    expect(lines.slice(0, 2).every((l) => l.trim() === "")).toBe(true);
    expect(lines.every((l) => l.startsWith("    ") && l.endsWith("    "))).toBe(true);
  });

  test("the width is one column per module", () => {
    const width = terminalQRWidth(link);
    expect(terminalQR(link).every((l) => [...stripColor(l)].length === width)).toBe(true);
    expect(terminalQR(link)).toHaveLength(Math.ceil(width / 2));
  });

  test("a code with four keys still fits an 80-column terminal", () => {
    const four = [ED25519, ECDSA, RSA, "SHA256:h3cjTPQJhsRsL4MfPTS9Insd64VNhAGhzUzD7mOynpY"];
    const long: PairingCode = { user: "a".repeat(32), host: "atlas.tail1234.ts.net", port: 65535, fingerprints: four };
    expect(terminalQRWidth(pairingLink(long))).toBeLessThanOrEqual(80);
  });
});

describe("pairReport", () => {
  test("the QR code comes first and the link is the last line", () => {
    const lines = pairReport({ code: CODE, keys: KEYS, hostFrom: "flag" }).trimEnd().split("\n");
    expect(lines[0]).toBe(terminalQR(pairingLink(CODE))[0]);
    expect(lines.at(-1)).toBe(pairingLink(CODE));
  });

  test("the fields are spelled out, with 22 for the default port and every key with its type", () => {
    const report = pairReport({ code: { ...CODE, port: PORT_UNSET }, keys: KEYS, hostFrom: "flag" });
    expect(report).toContain("  Account    dan\n  Host       atlas.example.net\n  Port       22\n");
    expect(report).toContain(`  Host keys  ${ED25519} (ED25519)\n             ${ECDSA} (ECDSA)\n`);
  });

  test("the host line says where the address came from", () => {
    expect(pairReport({ code: CODE, keys: KEYS, hostFrom: "ssh" })).toContain("(the address this ssh session reached)");
    expect(pairReport({ code: CODE, keys: KEYS, hostFrom: "name" })).toContain("run again with --host");
  });

  test("a terminal too narrow for the code gets the reason instead of a broken code", () => {
    const report = pairReport({ code: CODE, keys: KEYS, hostFrom: "flag", columns: 40 });
    expect(report).not.toContain("▀");
    expect(report).toContain(`This terminal is 40 columns wide, and the code needs ${terminalQRWidth(pairingLink(CODE))}.`);
    expect(report.trimEnd().split("\n").at(-1)).toBe(pairingLink(CODE));
  });
});

describe("pairCode", () => {
  test("valid fields make a code with the keys in order", () => {
    expect(pairCode("dan", { host: "atlas.example.net", port: 2222 }, KEYS)).toEqual(CODE);
  });

  test("an account that could become an ssh option is refused with the reader's own sentence", () => {
    expect(pairCode("-oProxyCommand=sh", { host: "atlas", port: PORT_UNSET }, KEYS)).toEqual({ error: PAIRING_PROBLEMS.user });
  });
});
