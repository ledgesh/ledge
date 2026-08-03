// The connection record and the ssh argv it becomes (remote.md §8, §4).
//
// Everything here is pure. The ssh hop itself is a native seam and belongs to
// the live probe (testing.md §6), but WHICH command gets run is the security
// posture of the whole transport, and that is a string comparison: an option
// dropped in a refactor would turn a pinned connection into one that trusts
// whoever answers, and nothing else in the system would notice.
//
// This machine's half only. What a destination and a pin ARE is both clients'
// and is tested in shared/connections.test.ts.
import { describe, expect, test } from "bun:test";
import {
  knownHostsText,
  LOCAL_CONNECTION,
  LOCAL_ID,
  parseConnections,
  parseFingerprint,
  pickHostKey,
  SSH_PATH,
  sshCommand,
  type Connection,
} from "./connections";

const CONN: Connection = {
  id: "c1",
  name: "Laptop",
  destination: "dev@laptop",
  keyPath: "",
  hostKey: "laptop ssh-ed25519 AAAAC3Nza",
  lastReached: 0,
};

const KNOWN = "/home/dev/.ledge/.client/known_hosts";
const USER = "/home/dev/.ssh/known_hosts";

describe("the ssh command", () => {
  const argv = sshCommand(CONN, KNOWN, USER);

  test("runs the server on the other machine", () => {
    expect(argv[0]).toBe(SSH_PATH);
    expect(argv.slice(-3)).toEqual(["dev@laptop", "ledge-server", "serve"]);
  });

  // This ssh has no terminal: its stdout IS the protocol. A prompt would hang
  // the connection or write a question mark into a frame header.
  test("never prompts", () => {
    expect(argv).toContain("BatchMode=yes");
  });

  // The blind accept remote.md §4 rules out. An unknown host is refused, a
  // changed one is refused, and neither is remembered.
  test("refuses an unknown or changed host key", () => {
    expect(argv).toContain("StrictHostKeyChecking=yes");
  });

  test("checks Ledge's pins first, then the user's own known hosts", () => {
    expect(argv).toContain(`UserKnownHostsFile=${KNOWN} ${USER}`);
  });

  // A system-wide file would be a third party to the pin.
  test("does not let a global known_hosts vouch for anything", () => {
    expect(argv).toContain("GlobalKnownHostsFile=/dev/null");
  });

  // Without -t there is no remote pty, and so no newline translation. A pty in
  // this path would corrupt a length-prefixed protocol rather than break it
  // visibly, which is the worst way for it to go wrong.
  test("allocates no terminal", () => {
    expect(argv).not.toContain("-t");
  });

  test("a named key is offered, and only it", () => {
    const withKey = sshCommand({ ...CONN, keyPath: "/home/dev/.ssh/ledge" }, KNOWN, USER);
    expect(withKey).toContain("/home/dev/.ssh/ledge");
    // Without IdentitiesOnly, ssh offers every key the agent holds first, and
    // a server with MaxAuthTries can refuse before reaching the named one.
    expect(withKey).toContain("IdentitiesOnly=yes");
  });

  test("no named key leaves the choice to ssh's own configuration", () => {
    expect(argv).not.toContain("-i");
    expect(argv).not.toContain("IdentitiesOnly=yes");
  });

  // Spawned with no shell, so the destination is one argv element with no
  // quoting of its own. What keeps that safe is the edge (validateConnection
  // below), which is the same predicate a note's `host:` frontmatter gets.
  test("the destination appears exactly once, and after every option", () => {
    expect(argv.filter((a) => a === "dev@laptop")).toHaveLength(1);
    expect(argv.indexOf("dev@laptop")).toBe(argv.lastIndexOf("-o") + 2);
  });
});

describe("the stored list", () => {
  test("round-trips a well-formed file", () => {
    const { connections, selected } = parseConnections({ version: 1, selected: "c1", connections: [CONN] });
    expect(connections).toEqual([CONN]);
    expect(selected).toBe("c1");
  });

  test("nothing stored means the local server, selected", () => {
    const { connections, selected } = parseConnections(undefined);
    expect(connections).toEqual([]);
    expect(selected).toBe(LOCAL_ID);
  });

  // Machine-written state self-heals (architecture.md §6): a bad entry costs
  // itself, never the file, and never the launch.
  test("a malformed entry costs itself and its neighbours survive", () => {
    const { connections } = parseConnections({
      connections: [{ id: "", name: "No id", destination: "h" }, "not an object", CONN, { id: "x", name: "y", destination: "-o" }],
    });
    expect(connections).toEqual([CONN]);
  });

  // The local id names the server in this process. A stored entry wearing it
  // could shadow the one connection that must always be reachable.
  test("a stored entry cannot claim the local id", () => {
    const { connections } = parseConnections({ connections: [{ ...CONN, id: LOCAL_ID }] });
    expect(connections).toEqual([]);
  });

  test("a duplicate id is dropped rather than shadowing the first", () => {
    const { connections } = parseConnections({ connections: [CONN, { ...CONN, name: "Impostor" }] });
    expect(connections).toEqual([CONN]);
  });

  // Booting into the wrong machine is the failure remote.md §8 spends a
  // paragraph on, so a dangling selection goes home rather than to a neighbour.
  test("a selection naming nothing falls back to the local server", () => {
    expect(parseConnections({ selected: "gone", connections: [CONN] }).selected).toBe(LOCAL_ID);
  });

  test("the local connection is not stored, and cannot be edited into being", () => {
    expect(LOCAL_CONNECTION.destination).toBe("");
    expect(LOCAL_CONNECTION.id).toBe(LOCAL_ID);
    expect(Object.isFrozen(LOCAL_CONNECTION)).toBe(true);
  });
});

describe("the pins file", () => {
  test("is the pinned lines and nothing else", () => {
    expect(knownHostsText([CONN, { ...CONN, id: "c2", hostKey: "other ssh-rsa AAAA" }])).toBe(
      "laptop ssh-ed25519 AAAAC3Nza\nother ssh-rsa AAAA\n",
    );
  });

  // It is a projection of the records, never an input: a connection with no
  // pin of its own (the user's ssh already trusted the host) contributes no
  // line, and an empty file is a valid one.
  test("connections with no pin contribute nothing", () => {
    expect(knownHostsText([{ ...CONN, hostKey: "" }])).toBe("");
    expect(knownHostsText([])).toBe("");
  });
});

describe("reading what a host answered", () => {
  // Real ssh-keyscan output: a banner comment per key, then the keys.
  const SCAN = [
    "# laptop:22 SSH-2.0-OpenSSH_9.6",
    "laptop ssh-rsa AAAAB3NzaC1yc2E",
    "# laptop:22 SSH-2.0-OpenSSH_9.6",
    "laptop ecdsa-sha2-nistp256 AAAAE2VjZHNh",
    "# laptop:22 SSH-2.0-OpenSSH_9.6",
    "laptop ssh-ed25519 AAAAC3NzaC1lZDI1",
  ].join("\n");

  // Pinning a key ssh will not negotiate refuses every connection with a
  // message about a CHANGED host key, which is the most alarming possible
  // wording for "we picked the wrong one".
  test("prefers the key type ssh itself prefers", () => {
    expect(pickHostKey(SCAN)).toBe("laptop ssh-ed25519 AAAAC3NzaC1lZDI1");
  });

  test("falls back through the preference order", () => {
    expect(pickHostKey("laptop ssh-rsa AAAAB3\nlaptop ecdsa-sha2-nistp256 AAAAE2")).toBe(
      "laptop ecdsa-sha2-nistp256 AAAAE2",
    );
  });

  test("banner comments are not keys", () => {
    expect(pickHostKey("# laptop:22 SSH-2.0-OpenSSH_9.6")).toBeNull();
  });

  test("nothing at all is what an unreachable host looks like from here", () => {
    expect(pickHostKey("")).toBeNull();
    expect(pickHostKey("\n\n")).toBeNull();
  });

  test("the fingerprint carries the hash and the algorithm, and nothing else", () => {
    expect(parseFingerprint("256 SHA256:abc123+def/ghi laptop (ED25519)\n")).toEqual({
      fingerprint: "SHA256:abc123+def/ghi",
      keyType: "ED25519",
    });
  });

  test("output ssh-keygen could not describe is null, not a guess", () => {
    expect(parseFingerprint("")).toBeNull();
    expect(parseFingerprint("laptop is not a key file")).toBeNull();
  });
});
