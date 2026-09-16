import { describe, expect, test } from "bun:test";
import { encode } from "uqr";
import { PORT_UNSET } from "../shared/connections";
import { PAIRING_PROBLEMS, pairingLink, QR_OPTIONS, type PairingCode } from "../shared/pairing";
import {
  addressCandidates,
  addressKind,
  type Candidate,
  candidateMenu,
  CONTAINER_COMMAND,
  containerRefusal,
  inCloud,
  othersNote,
  pairAddress,
  pairCode,
  pairReport,
  parsePairArgs,
  phoneHostKeys,
  publicAddressAnswer,
  sshClientAddress,
  sshServerAddress,
  tailscaleSelf,
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

describe("addressKind", () => {
  test("loopback, link-local, the tailnet range, the private ranges and everything else", () => {
    expect(addressKind("127.0.0.1")).toBe("loopback");
    expect(addressKind("169.254.169.254")).toBe("linkLocal");
    expect(addressKind("100.64.0.1")).toBe("tailnet");
    expect(addressKind("100.127.255.254")).toBe("tailnet");
    expect(addressKind("100.128.0.1")).toBe("public");
    expect(addressKind("10.1.2.3")).toBe("private");
    expect(addressKind("172.16.0.1")).toBe("private");
    expect(addressKind("172.31.255.255")).toBe("private");
    expect(addressKind("172.32.0.1")).toBe("public");
    expect(addressKind("192.168.1.10")).toBe("private");
    expect(addressKind("203.0.113.7")).toBe("public");
  });

  test("a name, an IPv6 address and an out-of-range quad are not addresses", () => {
    expect(addressKind("atlas")).toBeNull();
    expect(addressKind("fd7a:115c::1")).toBeNull();
    expect(addressKind("256.1.1.1")).toBeNull();
  });
});

describe("sshClientAddress", () => {
  test("the client's address is the first field, IPv4-mapped or not", () => {
    expect(sshClientAddress("198.51.100.4 51234 203.0.113.7 22")).toBe("198.51.100.4");
    expect(sshClientAddress("::ffff:10.0.0.9 51234 10.0.0.1 22")).toBe("10.0.0.9");
  });

  test("no session or an IPv6 client is null", () => {
    expect(sshClientAddress(undefined)).toBeNull();
    expect(sshClientAddress("fd7a:115c::1 51234 fd7a:115c::2 22")).toBeNull();
  });
});

describe("addressCandidates", () => {
  const LAN = { name: "en0", address: "192.168.1.10" };
  const DOCKER = { name: "docker0", address: "172.17.0.1" };

  test("with nothing but a name, the name", () => {
    expect(addressCandidates({ hostname: "atlas", interfaces: [] })).toEqual([
      { host: "atlas", source: "name", note: expect.stringContaining("this machine's name") },
    ]);
  });

  test("a session over the LAN: the session's address, then the other interfaces, then the name", () => {
    const hosts = addressCandidates({
      sshConnection: "192.168.1.20 51234 192.168.1.10 22",
      hostname: "atlas",
      interfaces: [LAN, { name: "en1", address: "192.168.2.10" }],
    }).map((c) => `${c.source}:${c.host}`);
    expect(hosts).toEqual(["ssh:192.168.1.10", "interface:192.168.2.10", "name:atlas"]);
  });

  test("a session that came through a NAT puts the cloud's public address first and says the session's is inside", () => {
    const list = addressCandidates({
      sshConnection: "198.51.100.4 51234 172.31.4.12 22",
      hostname: "ip-172-31-4-12",
      cloudAddress: "203.0.113.7",
      interfaces: [{ name: "eth0", address: "172.31.4.12" }],
    });
    expect(list.map((c) => `${c.source}:${c.host}`)).toEqual(["cloud:203.0.113.7", "ssh:172.31.4.12", "name:ip-172-31-4-12"]);
    expect(list[1]!.note).toContain("inside a NAT");
  });

  test("a tailnet name and address lead everything, and the tailnet interface is not listed twice", () => {
    const list = addressCandidates({
      sshConnection: "198.51.100.4 51234 203.0.113.7 22",
      hostname: "atlas",
      tailnet: { name: "atlas.tail1234.ts.net", addresses: ["100.101.102.103"] },
      cloudAddress: "203.0.113.7",
      interfaces: [{ name: "tailscale0", address: "100.101.102.103" }, { name: "eth0", address: "203.0.113.7" }],
    });
    expect(list.map((c) => `${c.source}:${c.host}`)).toEqual([
      "tailnet:atlas.tail1234.ts.net",
      "tailnet:100.101.102.103",
      "ssh:203.0.113.7",
      "name:atlas",
    ]);
  });

  test("without tailscale's own word, a 100.64/10 interface still counts as the tailnet", () => {
    const list = addressCandidates({ hostname: "atlas", interfaces: [{ name: "utun4", address: "100.101.102.103" }, LAN] });
    expect(list.map((c) => `${c.source}:${c.host}`)).toEqual(["tailnet:100.101.102.103", "interface:192.168.1.10", "name:atlas"]);
  });

  test("container bridges, loopback and link-local interfaces are left out; a private cloud answer is not believed", () => {
    const list = addressCandidates({
      hostname: "atlas",
      cloudAddress: "10.0.0.5",
      interfaces: [DOCKER, { name: "lo", address: "127.0.0.1" }, { name: "en0", address: "169.254.3.4" }, LAN],
    });
    expect(list.map((c) => c.host)).toEqual(["192.168.1.10", "atlas"]);
  });

  test("the same address from two sources is listed once, under the first", () => {
    const list = addressCandidates({ sshConnection: "192.168.1.20 51234 192.168.1.10 22", hostname: "Atlas", interfaces: [LAN] });
    expect(list.map((c) => `${c.source}:${c.host}`)).toEqual(["ssh:192.168.1.10", "name:Atlas"]);
  });
});

describe("tailscaleSelf", () => {
  const STATUS = (extra: object = {}) =>
    JSON.stringify({ BackendState: "Running", Self: { DNSName: "atlas.tail1234.ts.net.", TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"] }, ...extra });

  test("the MagicDNS name loses its trailing dot and only the IPv4 address is kept", () => {
    expect(tailscaleSelf(STATUS())).toEqual({ name: "atlas.tail1234.ts.net", addresses: ["100.101.102.103"] });
  });

  test("a node that is not running, a status with no self, and something that is not JSON are null", () => {
    expect(tailscaleSelf(STATUS({ BackendState: "Stopped" }))).toBeNull();
    expect(tailscaleSelf(JSON.stringify({ BackendState: "Running" }))).toBeNull();
    expect(tailscaleSelf("tailscale is not running")).toBeNull();
  });

  test("no MagicDNS name is null, with the addresses kept", () => {
    expect(tailscaleSelf(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.101.102.103"] } }))).toEqual({
      name: null,
      addresses: ["100.101.102.103"],
    });
  });
});

describe("publicAddressAnswer", () => {
  test("a public address with a newline is the address; an error page, an empty body and a private address are null", () => {
    expect(publicAddressAnswer("203.0.113.7\n")).toBe("203.0.113.7");
    expect(publicAddressAnswer("<html>404</html>")).toBeNull();
    expect(publicAddressAnswer("")).toBeNull();
    expect(publicAddressAnswer("172.31.4.12")).toBeNull();
  });
});

describe("candidateMenu", () => {
  test("hosts are numbered from 1 and padded so the notes line up", () => {
    const menu = candidateMenu([
      { host: "atlas.tail1234.ts.net", source: "tailnet", note: "tailnet" },
      { host: "203.0.113.7", source: "cloud", note: "cloud" },
    ]);
    expect(menu).toBe("Which address should Ledge on your other devices use to reach this server?\n   1  atlas.tail1234.ts.net  tailnet\n   2  203.0.113.7            cloud\n");
  });
});

describe("othersNote", () => {
  test("the unused candidates, with --host as the way to use one, and nothing when there are none", () => {
    const others: Candidate[] = [
      { host: "atlas.tail1234.ts.net", source: "tailnet", note: "the tailnet name" },
      { host: "atlas", source: "name", note: "the name" },
    ];
    expect(othersNote(others)).toBe(
      "Other addresses this machine has (run again with --host to use one):\n  atlas.tail1234.ts.net  the tailnet name\n  atlas                  the name\n",
    );
    expect(othersNote([])).toBe("");
  });
});

describe("inCloud", () => {
  test("each cloud's DMI tell", () => {
    expect(inCloud({ sys_vendor: "Amazon EC2\n" })).toBe(true);
    expect(inCloud({ sys_vendor: "Xen", bios_version: "4.11.amazon" })).toBe(true);
    expect(inCloud({ sys_vendor: "Google" })).toBe(true);
    expect(inCloud({ sys_vendor: "Microsoft Corporation", chassis_asset_tag: "7783-7084-3265-9085-8269-3286-77\n" })).toBe(true);
    expect(inCloud({ sys_vendor: "DigitalOcean" })).toBe(true);
    expect(inCloud({ sys_vendor: "Hetzner" })).toBe(true);
  });

  test("a home box, a local Hyper-V or QEMU machine, and no DMI at all are not a cloud", () => {
    expect(inCloud({ sys_vendor: "ASUSTeK COMPUTER INC." })).toBe(false);
    expect(inCloud({ sys_vendor: "Microsoft Corporation", chassis_asset_tag: "None" })).toBe(false);
    expect(inCloud({ sys_vendor: "QEMU", bios_version: "1.16.2-debian-1.16.2-1" })).toBe(false);
    expect(inCloud({})).toBe(false);
  });
});

describe("pairAddress", () => {
  const SESSION = "198.51.100.4 51234 203.0.113.7 2222";
  const CANDIDATES: Candidate[] = [
    { host: "203.0.113.7", source: "ssh", note: "the session's" },
    { host: "atlas", source: "name", note: "the name" },
  ];

  test("with no flags and no answer, the first candidate with the session's port and its note", () => {
    expect(pairAddress({}, SESSION, CANDIDATES)).toEqual({ host: "203.0.113.7", port: 2222, source: "ssh", note: "the session's" });
    expect(pairAddress({}, undefined, CANDIDATES.slice(1))).toEqual({ host: "atlas", port: PORT_UNSET, source: "name", note: "the name" });
  });

  test("no candidates at all is refused with --host as the way out", () => {
    expect(pairAddress({}, undefined, [])).toEqual({ error: expect.stringContaining("--host") });
  });

  test("a number picks from the list, and one past the end is refused", () => {
    expect(pairAddress({}, SESSION, CANDIDATES, "2")).toEqual({ host: "atlas", port: 2222, source: "name", note: "the name" });
    expect(pairAddress({}, SESSION, CANDIDATES, " 2 ")).toMatchObject({ host: "atlas" });
    expect(pairAddress({}, SESSION, CANDIDATES, "3")).toEqual({ error: "There is no address 3 in the list." });
    expect(pairAddress({}, SESSION, CANDIDATES, "0")).toHaveProperty("error");
  });

  test("an empty answer is the first candidate", () => {
    expect(pairAddress({}, SESSION, CANDIDATES, "")).toMatchObject({ host: "203.0.113.7", source: "ssh" });
  });

  test("a typed address is used as typed, with the session's port unless one follows a colon", () => {
    expect(pairAddress({}, SESSION, CANDIDATES, "atlas.example.net")).toEqual({
      host: "atlas.example.net",
      port: 2222,
      source: "typed",
      note: "",
    });
    expect(pairAddress({}, SESSION, CANDIDATES, "atlas.example.net:2200")).toMatchObject({ host: "atlas.example.net", port: 2200 });
    expect(pairAddress({}, SESSION, CANDIDATES, "atlas.example.net:22")).toMatchObject({ port: PORT_UNSET });
    expect(pairAddress({}, SESSION, CANDIDATES, "atlas.example.net:x")).toEqual({ error: '"x" is not a port from 1 to 65535.' });
  });

  test("--host wins over the list and the answer, and keeps the session's port", () => {
    expect(pairAddress({ host: "atlas.tail1234.ts.net" }, SESSION, CANDIDATES, "2")).toEqual({
      host: "atlas.tail1234.ts.net",
      port: 2222,
      source: "flag",
      note: "",
    });
  });

  test("--port wins over the session's port and a typed one, and --port 22 is the default port", () => {
    expect(pairAddress({ port: "2200" }, SESSION, CANDIDATES)).toMatchObject({ port: 2200 });
    expect(pairAddress({ port: "2200" }, SESSION, CANDIDATES, "atlas:2201")).toMatchObject({ port: 2200 });
    expect(pairAddress({ port: "22" }, SESSION, CANDIDATES)).toMatchObject({ port: PORT_UNSET });
  });

  test("a --port that is not a port is refused", () => {
    expect(pairAddress({ port: "22x" }, undefined, CANDIDATES)).toEqual({ error: '"22x" is not a port from 1 to 65535.' });
    expect(pairAddress({ port: "0" }, undefined, CANDIDATES)).toHaveProperty("error");
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
    const lines = pairReport({ code: CODE, keys: KEYS, note: "" }).trimEnd().split("\n");
    expect(lines[0]).toBe(terminalQR(pairingLink(CODE))[0]);
    expect(lines.at(-1)).toBe(pairingLink(CODE));
  });

  test("the fields are spelled out, with 22 for the default port and every key with its type", () => {
    const report = pairReport({ code: { ...CODE, port: PORT_UNSET }, keys: KEYS, note: "" });
    expect(report).toContain("  Account    dan\n  Host       atlas.example.net\n  Port       22\n");
    expect(report).toContain(`  Host keys  ${ED25519} (ED25519)\n             ${ECDSA} (ECDSA)\n`);
  });

  test("the host line carries the note", () => {
    const report = pairReport({ code: CODE, keys: KEYS, note: "the address this ssh session reached" });
    expect(report).toContain("  Host       atlas.example.net (the address this ssh session reached)\n");
  });

  test("a terminal too narrow for the code gets the reason instead of a broken code", () => {
    const report = pairReport({ code: CODE, keys: KEYS, note: "", columns: 40 });
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
