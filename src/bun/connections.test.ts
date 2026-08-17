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
  explainDial,
  knownHostsText,
  LOCAL_CONNECTION,
  LOCAL_ID,
  parseConnections,
  parseFingerprint,
  pickHostKey,
  PORT_UNSET,
  SSH_PATH,
  sshDial,
  type Connection,
} from "./connections";
import { ASKPASS_ACCOUNT_ENV } from "./secrets";

const CONN: Connection = {
  id: "c1",
  name: "Laptop",
  destination: "dev@laptop",
  port: PORT_UNSET,
  keyPath: "",
  auth: "key",
  hostKey: "laptop ssh-ed25519 AAAAC3Nza",
  lastReached: 0,
};

const KNOWN = "/home/dev/.ledge/.client/known_hosts";
const USER = "/home/dev/.ssh/known_hosts";
const ASKPASS = "/home/dev/.ledge/.client/askpass.sh";
const FILES = { knownHosts: KNOWN, userKnownHosts: USER, askpass: ASKPASS };
const dial = (conn: Connection) => sshDial(conn, FILES);

describe("the ssh command", () => {
  const { argv } = dial(CONN);

  test("runs the server on the other machine", () => {
    expect(argv[0]).toBe(SSH_PATH);
    expect(argv.slice(-3)).toEqual(["dev@laptop", "ledge-server", "serve"]);
  });

  // A connection that names no port passes none, so ssh's own configuration
  // decides — which is what keeps a `~/.ssh/config` alias's `Port` working. A
  // form defaulting to 22 and always sending it would override that silently.
  test("a port is passed only when the connection names one", () => {
    expect(argv).not.toContain("-p");
    const { argv: moved } = dial({ ...CONN, port: 2222 });
    expect(moved.join(" ")).toContain("-p 2222");
    // Still ahead of the destination, which is where ssh takes its options.
    expect(moved.indexOf("-p")).toBeLessThan(moved.indexOf("dev@laptop"));
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

  // Both default to off, and off means a wire that stops carrying bytes without
  // closing is never noticed: no FIN, no RST, and macOS does not probe an idle
  // socket for two hours. Everything in shared/transport.ts hangs off the
  // connection ending, so without these the reconnect ladder cannot run at all.
  // A number here is a claim about how long that takes, so assert the numbers.
  test("notices a wire that went silent without closing", () => {
    expect(argv).toContain("ServerAliveInterval=5");
    expect(argv).toContain("ServerAliveCountMax=3");
  });

  // Dialling into that same hole hangs on the SYN or on the banner, and a rung
  // of the ladder that never returns leaves a ladder with one rung.
  test("gives up on a dial that goes unanswered", () => {
    expect(argv).toContain("ConnectTimeout=10");
  });

  // Without -t there is no remote pty, and so no newline translation. A pty in
  // this path would corrupt a length-prefixed protocol rather than break it
  // visibly, which is the worst way for it to go wrong.
  test("allocates no terminal", () => {
    expect(argv).not.toContain("-t");
  });

  test("a named key is offered, and only it", () => {
    const { argv: withKey } = dial({ ...CONN, keyPath: "/home/dev/.ssh/ledge" });
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

  // Nothing about the key door needs one, and an environment set here would be
  // an environment ssh passes to every child it forks.
  test("a key connection asks for no environment", () => {
    expect(dial(CONN).env).toEqual({});
  });
});

// The other door (remote.md §4). Every claim here was measured against a real
// password-only sshd before it was written down, and the one that reversed this
// section is the first: BatchMode=yes suppresses SSH_ASKPASS entirely, force
// included, so the helper is never spawned and no password is ever offered.
describe("the ssh command for a password connection", () => {
  const PASS: Connection = { ...CONN, auth: "password" };
  const { argv, env } = dial(PASS);

  test("turns batch mode off, because it is what blocks the helper", () => {
    expect(argv).toContain("BatchMode=no");
    expect(argv).not.toContain("BatchMode=yes");
  });

  // What BatchMode was buying, bought by narrower options. Without this one an
  // askpass that answers wrongly is retried up to the server's MaxAuthTries,
  // which is the unbounded prompting a batch mode exists to prevent.
  test("asks once and gives up", () => {
    expect(argv).toContain("NumberOfPasswordPrompts=1");
  });

  // The other half is unchanged, and has to be: it is what makes turning
  // BatchMode off affordable, since a host key question is refused outright
  // rather than asked.
  test("still refuses an unknown or changed host key", () => {
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv).toContain(`UserKnownHostsFile=${KNOWN} ${USER}`);
    expect(argv).toContain("GlobalKnownHostsFile=/dev/null");
  });

  // A loaded agent otherwise offers every key it holds before the password is
  // tried, and each refusal counts against the server's MaxAuthTries.
  test("offers no key at all", () => {
    expect(argv).toContain("PubkeyAuthentication=no");
    expect(argv).not.toContain("-i");
    expect(argv).not.toContain("IdentitiesOnly=yes");
    // Even when the record still carries a path from before it was switched.
    expect(dial({ ...PASS, keyPath: "/home/dev/.ssh/ledge" }).argv).not.toContain("/home/dev/.ssh/ledge");
  });

  // Both, because a great many sshd configurations answer with
  // keyboard-interactive where this one would say password, and askpass serves
  // both.
  test("names both of the methods a password can arrive by", () => {
    expect(argv).toContain("PreferredAuthentications=password,keyboard-interactive");
  });

  // force rather than a bare SSH_ASKPASS, which OpenSSH ignores when there is
  // no DISPLAY set — and there never is one here.
  test("points ssh at the helper and names which connection it is for", () => {
    expect(env["SSH_ASKPASS"]).toBe(ASKPASS);
    expect(env["SSH_ASKPASS_REQUIRE"]).toBe("force");
    expect(env[ASKPASS_ACCOUNT_ENV]).toBe(PASS.id);
  });

  // The helper reads the password out of the keychain, so nothing here has one
  // to leak. Pinned as an exact set rather than as three lookups: a fourth
  // variable added here is inherited by every process ssh forks, and this is
  // what makes adding one a decision instead of an accident.
  test("passes exactly three variables, and no secret among them", () => {
    expect(Object.keys(env).sort()).toEqual(["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", ASKPASS_ACCOUNT_ENV].sort());
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

  // A record written before the field existed, and one whose port is nonsense,
  // are the same thing to a reader: a connection that opens wherever ssh
  // decides, which is where it opened before.
  test("a missing or unusable port costs itself and not the record", () => {
    const read = (port: unknown) => parseConnections({ connections: [{ ...CONN, port }] }).connections[0]!;
    expect(parseConnections({ connections: [{ ...CONN, port: undefined }] }).connections[0]!.port).toBe(PORT_UNSET);
    expect(read(2222).port).toBe(2222);
    expect(read("2222").port).toBe(PORT_UNSET);
    expect(read(0).port).toBe(PORT_UNSET);
    expect(read(-1).port).toBe(PORT_UNSET);
    expect(read(70000).port).toBe(PORT_UNSET);
    expect(read(22.5).port).toBe(PORT_UNSET);
    // And the rest of the record is untouched by any of it.
    expect(read("2222")).toEqual({ ...CONN, port: PORT_UNSET });
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

// Every string below was taken from a real ssh, against a real sshd in Docker,
// by pointing the client at a machine that had each fault in turn. The point of
// the function is that the transport cannot tell these apart — all four reach
// it as "the connection to the server closed" — so a paraphrase would be
// testing the paraphrase.
describe("why the dial failed", () => {
  test("the shell's word for a server that was never installed becomes the sentence that says so", () => {
    const said = explainDial("bash: line 1: ledge-server: command not found\n");
    expect(said).toBe("Ledge's server is not installed on that machine. Install it there, then try again.");
  });

  test("every login shell's way of saying it, because the far machine's shell is not ours to choose", () => {
    for (const line of [
      "bash: line 1: ledge-server: command not found",
      "sh: 1: ledge-server: not found",
      "zsh:1: command not found: ledge-server",
      "ksh: ledge-server: not found",
    ]) {
      expect(explainDial(line)).toContain("is not installed on that machine");
    }
  });

  test("ssh's own diagnoses are passed through, not rewritten", () => {
    expect(explainDial("linuxuser@10.0.0.4: Permission denied (publickey,password).")).toBe(
      "linuxuser@10.0.0.4: Permission denied (publickey,password).",
    );
    expect(explainDial("ssh: connect to host 10.0.0.4 port 22: Operation timed out")).toBe(
      "ssh: connect to host 10.0.0.4 port 22: Operation timed out",
    );
    expect(explainDial("Connection timed out during banner exchange")).toBe(
      "Connection timed out during banner exchange",
    );
  });

  test("the last line wins, because ssh narrates before it fails", () => {
    const noisy = [
      "Warning: Identity file /Users/dev/.ssh/ledge not accessible: No such file or directory.",
      "linuxuser@10.0.0.4: Permission denied (publickey).",
    ].join("\n");
    expect(explainDial(noisy)).toBe("linuxuser@10.0.0.4: Permission denied (publickey).");
  });

  test("lines that are also true of connections that worked are not a diagnosis", () => {
    expect(explainDial("Warning: Permanently added '10.0.0.4' to the list of known hosts.\n")).toBeNull();
    expect(explainDial("Pseudo-terminal will not be allocated because stdin is not a terminal.\n")).toBeNull();
  });

  // The far end saying it is UP, reported as the reason it could not be
  // reached. It is the last line on stderr whenever the dial worked and the
  // protocol then refused, which is every version mismatch.
  test("the server's own startup banner is not a diagnosis either", () => {
    expect(explainDial("[serve] ledge-server 0.1.0 attached to /home/linuxuser/.ledge/.server.sock\n")).toBeNull();
    expect(
      explainDial(
        [
          "Warning: Permanently added '10.0.0.4' to the list of known hosts.",
          "[serve] ledge-server 0.1.0 attached to /home/linuxuser/.ledge/.server.sock",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  // Dropping the banner must not drop what came after it: a server that
  // attached and then died says both, and the second one is the answer.
  test("a fault after the banner is still the fault", () => {
    const said = ["[serve] ledge-server 0.1.0 attached to /home/linuxuser/.ledge/.server.sock", "Killed"].join("\n");
    expect(explainDial(said)).toBe("Killed");
  });

  test("a server that accepted the connection and then went quiet has nothing to add", () => {
    expect(explainDial("")).toBeNull();
    expect(explainDial("   \n\n  \n")).toBeNull();
  });
});
