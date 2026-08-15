#!/usr/bin/env bun
// The ssh hop, against a real sshd, with a real forced-command key.
//
// This is the debt phases 2, 3 and 4 of docs/contributor/remote.md all
// recorded: everything up to here ran over pipes and a unix socket, which are
// real process boundaries and not a network. What was unproven was ssh itself
// — the argv `bun/connections.ts` builds, the `authorized_keys` restriction
// §4 describes, the host-key pin, and a length-prefixed protocol surviving a
// transport that was designed for terminals.
//
// It uses Ledge's OWN modules for everything it is testing: sshDial builds the
// argv and the environment, secrets.ts writes the keychain item and the askpass
// helper, pickHostKey chooses what to pin, knownHostsText writes the file,
// clientConnection speaks the protocol. A probe that hand-wrote an ssh command
// line would prove that ssh works, which was never in doubt.
//
// Run it: `bun run probe:ssh`. It builds two images, holds 127.0.0.1:22 for a
// few seconds, and removes everything it made.
//
// `bun run probe:ssh -- --serve` is the same fixture with the assertions left
// off and the container left up, for the one client that cannot reach loopback:
// a real phone (ios.md §13). It publishes on every interface rather than
// 127.0.0.1, prints the address to type on the pairing screen and the host key
// to confirm there, and appends whatever `authorized_keys` line is pasted into
// it. Ctrl-C takes it all down again.
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = await mkdtemp(join(tmpdir(), "ledge-ssh-probe-"));
// Before any Ledge module loads: importing the client modules derives the
// client home from APP_HOME, and a probe must never touch the real ~/.ledge
// (testing.md §6).
process.env["LEDGE_NOTES_ROOT"] = join(SCRATCH, "home");

const { sshDial, pickHostKey, knownHostsText, PORT_UNSET } = await import("../src/bun/connections");
const { ensureAskpass, forgetPassword, storePassword } = await import("../src/bun/secrets");
type Connection = import("../src/bun/connections").Connection;
const { clientConnection, reconnectingClient } = await import("../src/shared/transport");
const { spawnDuplex } = await import("../src/bun/transport");
const { PUSH_MESSAGES, sessionHold } = await import("../src/shared/wire");
const { BUILD_VERSION } = await import("../src/shared/version");
type ServerPush = import("../src/shared/wire").ServerPush;
type PeerInfo = import("../src/shared/rpc-schema").PeerInfo;

const REPO = join(import.meta.dir, "..");
const IMAGE = "ledge-server:probe";
const FIXTURE = "ledge-sshd:probe";
const NAME = "ledge-ssh-probe";

// Stand the fixture up for a phone instead of asserting against it.
const SERVE = Bun.argv.includes("--serve");

let failures = 0;
const ok = (claim: string, detail = "") => console.log(`  ok    ${claim}${detail && `  (${detail})`}`);
const bad = (claim: string, detail = "") => {
  failures++;
  console.log(`  FAIL  ${claim}${detail && `  (${detail})`}`);
};
const check = (claim: string, cond: boolean, detail = "") => (cond ? ok(claim, detail) : bad(claim, detail));
const step = (s: string) => console.log(`\n${s}`);

function run(cmd: string[], opts: { quiet?: boolean; env?: Record<string, string> } = {}) {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env } });
  const out = p.stdout.toString().trim();
  const err = p.stderr.toString().trim();
  if (p.exitCode !== 0 && !opts.quiet) throw new Error(`${cmd.slice(0, 3).join(" ")}… exited ${p.exitCode}\n${err || out}`);
  return { code: p.exitCode, out, err };
}

// The keychain items this run writes, swept even when a claim throws. The
// login keychain is the one thing a probe touches that is not under SCRATCH
// (testing.md §6), so it is cleaned unconditionally rather than at the end of
// the step that made it.
const secrets: string[] = [];

async function teardown() {
  for (const name of [NAME, `${NAME}-pw`, `${NAME}-kbd`, `${NAME}-plain`]) {
    run(["docker", "rm", "-f", name], { quiet: true });
  }
  for (const id of secrets) await forgetPassword(id);
  await rm(SCRATCH, { recursive: true, force: true });
}

/**
 * A wire that stops carrying bytes, and the same wire again.
 *
 * The instrument is an iptables rule inside the container, on the way OUT.
 * From a client's end that is a severed wire exactly: nothing arrives, and
 * nothing says why — no FIN, no RST, no exit. What it buys over cutting both
 * directions is that a request still REACHES the far machine and is executed,
 * and only its answer is lost, which is the one condition bun/opLog.ts was
 * written for.
 *
 * Not `docker pause` and not `docker kill`. Both take the far end down with the
 * wire, and half of what is being claimed is that the daemon and its shells
 * carry on while the client cannot see them.
 *
 * Both directions delete the rule first, so they are idempotent: a cut asked
 * for twice leaves one rule rather than two for a mend to peel off one at a
 * time.
 */
const RULE = ["OUTPUT", "-p", "tcp", "--sport", "22", "-j", "DROP"];
const iptables = (flag: string) => run(["docker", "exec", NAME, "iptables", flag, ...RULE], { quiet: true });
const mendWire = () => iptables("-D");
const cutWire = () => {
  iptables("-D");
  iptables("-I");
};

/**
 * A server that stops answering while the wire stays perfect, and the same
 * server again.
 *
 * The instrument is SIGSTOP on the daemon, and it is the cut's opposite in
 * every way that matters. Nothing between the two ends breaks: the TCP
 * connection is established and its keepalives are answered, sshd answers
 * `ServerAliveInterval` from its own process, and `ledge-server serve` goes on
 * pumping bytes into a unix socket whose reader is not running. Every
 * mechanism below the protocol therefore reports a healthy connection,
 * correctly, because from where each of them sits it is one.
 *
 * So this is the failure only the heartbeat can see, and the reason it is in
 * the protocol rather than in a transport: a pong comes from the process
 * holding the notes, and no hop between here and it can send one on its behalf.
 *
 * The pid is the daemon's own record of itself, beside its socket
 * (bun/daemon.ts). The path is spelled out because two different accounts are
 * involved and neither `$HOME` names the right one: the daemon belongs to the
 * `ledge` account, since an ssh session does not inherit a Dockerfile's `ENV`
 * and `LEDGE_NOTES_ROOT` is therefore unset when the forced command runs,
 * leaving the app home at `~ledge/.ledge` rather than at the image's `/data`;
 * while `docker exec` on this fixture lands as root, because the fixture adds
 * an sshd and switches back to run it. The [container] step reads `/data`
 * instead, and that is the same difference from the other side.
 *
 * A failed signal throws rather than passing quietly. Silence here does not
 * fail the step, it EMPTIES it: the server goes on answering and the claim
 * below reads as a client that noticed nothing, which is indistinguishable
 * from the bug it is looking for.
 */
const PID_FILE = "/home/ledge/.ledge/.server.pid";
const daemonPid = () => run(["docker", "exec", NAME, "sh", "-c", `cat ${PID_FILE}`], { quiet: true }).out.trim();
const signalDaemon = (sig: "STOP" | "CONT") => {
  const sent = run(["docker", "exec", NAME, "sh", "-c", `kill -${sig} $(cat ${PID_FILE})`], { quiet: true });
  if (sent.code !== 0) throw new Error(`could not send SIG${sig} to the daemon: ${sent.err || sent.out || "no such process"}`);
};

try {
  // Port 22 and not a high one for the key fixture: it predates the port field
  // and the [password] step below is what exercises a high one. An ssh
  // destination has no port in it (the same constraint testing.md §6 records
  // for `host:` shells). Loopback only, and gone at teardown — except under
  // --serve, where the whole point is a client that is not on this machine, so
  // the check widens to every interface along with the binding.
  const where = SERVE ? "" : "@127.0.0.1";
  const held = run(["sh", "-c", `lsof -nP -iTCP${where}:22 -sTCP:LISTEN 2>/dev/null | tail -n +2`], { quiet: true });
  if (held.out) throw new Error(`something already listens on port 22:\n${held.out}\nStop it, or run this elsewhere.`);

  step("[build] the shipped image, then the fixture that adds an sshd to it");
  run(["docker", "build", "-t", IMAGE, REPO]);
  run(["docker", "build", "--build-arg", `BASE=${IMAGE}`, "-t", FIXTURE, join(import.meta.dir, "ssh-probe")]);
  console.log(`  ${IMAGE} and ${FIXTURE} built`);

  step("[key] a throwaway pair, offered under the forced command");
  const keyPath = join(SCRATCH, "id_ed25519");
  run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "ledge-probe", "-f", keyPath]);
  const pub = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  // NET_ADMIN for both modes, because both cut the wire: the assertion run does
  // it to itself in [drop], and --serve does it on command so a phone's own
  // detection can be watched (ios.md §5). The capability reaches the container's
  // network namespace and nothing outside it.
  run([
    ...["docker", "run", "-d", "--name", NAME, "--cap-add=NET_ADMIN"],
    ...["-p", SERVE ? "22:22" : "127.0.0.1:22:22", "-e", `LEDGE_PUBKEY=${pub}`, FIXTURE],
  ]);
  console.log(`  authorized_keys: restrict,command="ledge-server serve" ${pub.slice(0, 32)}…`);

  step("[pair] scan the host key and pin it, the way the app's pairing does");
  let scan = "";
  for (let i = 0; i < 40 && !pickHostKey(scan); i++) {
    await Bun.sleep(250);
    scan = run(["ssh-keyscan", "-T", "2", "127.0.0.1"], { quiet: true }).out;
  }
  const hostKey = pickHostKey(scan);
  if (!hostKey) throw new Error("the fixture's sshd never answered ssh-keyscan");
  const fingerprint = run(["sh", "-c", `printf '%s\\n' ${JSON.stringify(hostKey)} | ssh-keygen -lf -`]).out;
  ok("the host key was scanned and pinned", fingerprint.split(" ").slice(0, 2).join(" "));

  if (SERVE) {
    // The address this Mac answers on, from the interface that carries traffic
    // off it. Asked rather than assumed to be en0: a Mac on ethernet, or with a
    // second adapter, answers somewhere else, and a printed address that is not
    // the right one is worse than none.
    const iface = run(["sh", "-c", "route -n get default 2>/dev/null | awk '/interface:/{print $2}'"], {
      quiet: true,
    }).out;
    const lan = iface ? run(["ipconfig", "getifaddr", iface], { quiet: true }).out : "";
    if (!lan) throw new Error("this Mac has no address on a default route; connect it to the network the phone is on");

    console.log(`
  Pair the phone with    ledge@${lan}
  Confirm this host key  ${fingerprint.split(" ").slice(0, 2).join(" ")}

  This sshd answers on every interface for as long as this runs, on ${iface}
  and any other. It takes public keys only and pins each one to a single
  command, which is the same posture remote.md §4 asks of a real server.

  Copy the line the phone's pairing screen shows, paste it here, press Enter.
  Type  cut     to stop this end answering, without closing anything. Requests
                from the phone hang; the daemon and its shells carry on.
  Type  mend    to let the replies through again.
  Type  stall   to stop the DAEMON while the wire stays perfect. The phone's
                bar reaches "reconnecting" in about twenty seconds, and this is
                the case that proves it: sshd, TCP and Docker's published port
                are all healthy and answering, so the only thing that can
                notice is the protocol's own heartbeat (remote.md §7).
  Type  resume  to start it answering again; the ladder climbs back.
  Ctrl-C takes the fixture down and removes it.

  A cut alone will NOT reach "reconnecting" from a Simulator: it is behind
  Docker's published port, and that proxy answers the phone's keepalives
  itself (ios.md §13). Use stall, or take this Mac off the network.
`);

    // `$1` rather than interpolation: the line is pasted from another device
    // and goes to a shell, and there is no reason for it to be able to reach
    // one.
    const authorize = (line: string) =>
      run(
        [
          ...["docker", "exec", NAME, "sh", "-c"],
          'printf "%s\\n" "$1" >> /home/ledge/.ssh/authorized_keys',
          "sh",
          line,
        ],
        { quiet: true },
      );

    const stopped = new Promise<void>((resolve) => process.on("SIGINT", () => resolve()));
    void (async () => {
      for await (const raw of console) {
        const text = raw.trim();
        if (!text) continue;
        // The wire, by hand. A phone cannot be driven from here, so the half of
        // the claim a harness can supply is the cut itself: the server keeps
        // running while the client cannot see it, and the requests made in the
        // gap are held. The other half — noticing — is not testable through a
        // published port at all (ios.md §13).
        if (text === "cut" || text === "mend") {
          const cut = text === "cut";
          (cut ? cutWire : mendWire)();
          console.log(cut ? "  cut: replies dropped, and nothing tells the phone" : "  mended: replies are getting out again");
          continue;
        }
        // The half a harness CAN supply for a phone, and the one the cut above
        // cannot: everything between the two ends stays healthy and the server
        // stops answering, so what the bar reports is the heartbeat and nothing
        // else (`signalDaemon`).
        if (text === "stall" || text === "resume") {
          const stall = text === "stall";
          signalDaemon(stall ? "STOP" : "CONT");
          console.log(
            stall
              ? `  stalled: daemon ${daemonPid()} is stopped, the wire is perfect, the bar should turn in about 20s`
              : "  resumed: the daemon is answering again",
          );
          continue;
        }
        // A bare public key is the easy mistake and the difference matters: a
        // line with no restriction on it is a key that can open a shell. Wrap
        // it rather than refuse it, because the phone's own line already has
        // the restriction and this only catches someone who copied the key box
        // above it.
        const bare = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+)\s+\S+/.test(text);
        if (!bare && !text.includes('command="ledge-server serve"')) {
          console.log("  that is not an authorized_keys line; copy the whole line the pairing screen shows");
          continue;
        }
        authorize(bare ? `restrict,command="ledge-server serve" ${text}` : text);
        const count = run(["docker", "exec", NAME, "sh", "-c", "grep -c . /home/ledge/.ssh/authorized_keys"], {
          quiet: true,
        }).out;
        console.log(`  authorized${bare ? " (wrapped in the forced command)" : ""}: ${count} key(s) on the server`);
      }
    })();

    await stopped;
    console.log("");
    // Explicitly, because process.exit skips the finally below.
    await teardown();
    console.log(`[-] container removed, scratch home removed (${SCRATCH})`);
    process.exit(0);
  }

  const conn: Connection = {
    id: "probe",
    name: "Probe",
    // user@host, because a bare host makes ssh offer the LOCAL username and
    // the account on the other side is the one that owns the notes. Getting
    // this wrong is a plain "Permission denied (publickey)", which is also
    // what a wrong key looks like — worth knowing before it happens to a user.
    destination: "ledge@127.0.0.1",
    port: PORT_UNSET,
    keyPath,
    auth: "key",
    hostKey,
    lastReached: 0,
  };
  const knownHosts = join(SCRATCH, "known_hosts");
  await writeFile(knownHosts, knownHostsText([conn]));
  // /dev/null for the user's own file: this probe has no business reading, and
  // certainly none writing, the developer's ~/.ssh/known_hosts.
  // No askpass: this connection is a key, and `sshDial` asks for none.
  const { argv } = sshDial(conn, { knownHosts, userKnownHosts: "/dev/null", askpass: "" });
  console.log(`  ${argv.join(" ")}`);

  step("[forced command] the key cannot ask for anything else");
  // Same argv, different remote command. sshd runs what authorized_keys says
  // regardless, so `whoami` never executes — §4's "that key cannot open a
  // shell", as a thing that either happens or does not.
  //
  // Both halves have to be asserted. That `ledge` is absent from the output
  // would also be true if authentication had simply failed, which is how this
  // check first passed for the wrong reason; the server's own handshake in
  // that same output is what says the session opened AND was redirected.
  const asked = run([...argv.slice(0, -2), "whoami"], { quiet: true });
  check("the session opened", asked.out.includes(BUILD_VERSION), asked.err.split("\n")[0]?.slice(0, 60));
  check("but ran the forced command, not the one asked for", !/^ledge$/m.test(asked.out));
  const shell = run([...argv.slice(0, -2)], { quiet: true });
  check("asking for a shell gets the protocol instead", shell.out.includes(BUILD_VERSION) && !/\$ $|# $/.test(shell.out));

  step("[pin] a changed host key is refused, with no way to say yes anyway");
  const badPin = join(SCRATCH, "known_hosts.bad");
  const parts = hostKey.split(/\s+/);
  // Same host, same key type, one different key: what a machine-in-the-middle
  // looks like from here.
  const other = run(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", join(SCRATCH, "other")]);
  void other;
  const otherPub = (await readFile(join(SCRATCH, "other.pub"), "utf8")).trim().split(/\s+/);
  await writeFile(badPin, `${parts[0]} ${otherPub[0]} ${otherPub[1]}\n`);
  const refused = run(sshDial(conn, { knownHosts: badPin, userKnownHosts: "/dev/null", askpass: "" }).argv, { quiet: true });
  check("a wrong pin refuses the connection", refused.code !== 0, `exit ${refused.code}`);
  const said = refused.err.split("\n").find((l) => /host key|verification failed/i.test(l)) ?? "";
  check("and says why", said.length > 0, said.slice(0, 66));
  check("with nothing offering to continue anyway", !/yes\/no|continue connecting/i.test(refused.err));

  step("[connect] the protocol over ssh");
  // One record of pushes PER CONNECTION, because what a client was told is now
  // half of what is being proven (remote.md §7): a shared record cannot tell
  // "the phone was not told" from "nobody was".
  const ears = () => {
    const heard: Array<[string, unknown]> = [];
    const push = Object.fromEntries(
      PUSH_MESSAGES.map((m) => [m, (p: unknown) => heard.push([m, p])]),
    ) as unknown as ServerPush;
    return { heard, push };
  };
  const mac = ears();
  // Standing in for a phone: the same number mainview/ios.tsx sends
  // (SESSION_HOLD_MS), asked over a real ssh hop rather than a pipe, because a
  // hello field that survives a unix socket is not yet a hello field that
  // survived ssh.
  const ASK = 5 * 60_000;
  const client = clientConnection(spawnDuplex(argv), {
    push: mac.push,
    build: BUILD_VERSION,
    client: "probe-mac",
    // What the other clients on this server will call it (remote.md §7). A
    // string in the handshake that has to survive an ssh hop, like the hold.
    label: "Probe Studio",
    hold: ASK,
  });
  const t0 = Date.now();
  const hello = await client.ready;
  ok("handshake", `ledge-server ${hello.build}, instance ${hello.instance.slice(0, 8)}, ${Date.now() - t0}ms`);
  check("the server is the build we shipped in the image", hello.build === BUILD_VERSION, hello.build);

  const trips: number[] = [];
  for (let i = 0; i < 5; i++) {
    const at = Date.now();
    await client.requests.workspaceList({});
    trips.push(Date.now() - at);
  }
  ok("round trip", `${Math.min(...trips)}-${Math.max(...trips)}ms over ssh to a container`);

  step("[notes] a workspace and a note, on the other machine");
  const { root } = await client.requests.workspaceCreate({ name: "Probe" });
  ok("workspaceCreate", root);
  await client.call("noteCreate", { root, text: "# Over SSH\n\nwritten across the wire\n" }, "probe:note:1");
  // The same op twice: a replayed write applies once (§7), now over a
  // transport that can actually drop.
  await client.call("noteCreate", { root, text: "# Over SSH\n\nwritten across the wire\n" }, "probe:note:1");
  const { notes } = await client.requests.noteList({ root });
  const mine = notes.filter((n) => n.title === "Over SSH");
  check("the note crossed the wire", mine.length >= 1, `${mine.length} found`);
  check("and a replayed op applied once", mine.length === 1, `${mine.length} notes named "Over SSH"`);
  const read = await client.requests.noteRead({ path: mine[0]!.path });
  check("its text reads back", (read.note?.text ?? "").includes("written across the wire"));

  step("[terminal] a Linux pty, driven from macOS, through ssh and a daemon");
  await client.requests.sessionConfigure({
    sessionId: "s1",
    params: { cwd: root, env: {}, hosts: [] } as never,
    notePath: null,
  });
  const attach = await client.requests.terminalAttach({ sessionId: "s1", host: null });
  ok("terminalAttach", `host ${attach.host}`);
  const output = () =>
    mac.heard
      .filter(([m]) => m === "terminalOutput")
      .map(([, p]) => atob((p as { dataB64: string }).dataB64))
      .join("");
  // Typed more than once on purpose. zsh's line editor resets the terminal as
  // it comes up and discards whatever was pending, so a command sent the
  // instant terminalAttach returns can be swallowed whole — which is exactly
  // why the app waits for its marker hook rather than typing into a shell it
  // has not heard from.
  const deadline = Date.now() + 15_000;
  let seen = "";
  while (Date.now() < deadline && !/Linux[\s\S]*PTY-42/.test(seen)) {
    await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa("uname -s; echo PTY-$((6*7))\n") });
    for (let i = 0; i < 12 && !/Linux[\s\S]*PTY-42/.test(seen); i++) {
      await Bun.sleep(100);
      seen = output();
    }
  }
  check("the shell ran and answered", seen.includes("PTY-42"));
  check("and it is a Linux one", /Linux[\s\S]*PTY-42/.test(seen), JSON.stringify(seen.slice(-120)));

  // The other half of a drawer: its window's grid, which reaches the pty as an
  // ioctl and nothing else can be checked from. It is the owner's call now, and
  // the drawer sends it only after the attach that makes it one — so a shell
  // that answers with the pty's own 120x30 means the resize never landed.
  await client.requests.terminalResize({ sessionId: "s1", cols: 100, rows: 20 });
  const SIZED = /SIZE-20-100/;
  let winsize = "";
  const sizeBy = Date.now() + 10_000;
  while (Date.now() < sizeBy && !SIZED.test(winsize)) {
    await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa('echo SIZE-$(stty size | tr " " "-")\n') });
    for (let i = 0; i < 12 && !SIZED.test(winsize); i++) {
      await Bun.sleep(100);
      winsize = output();
    }
  }
  check("and a resize reached its winsize", SIZED.test(winsize), JSON.stringify(winsize.slice(-60)));

  // A block left running on the far machine, so the [orphan] step below has
  // something real to collect. `sleep` rather than anything that prints: what
  // has to be true is that it is still executing when its client goes away.
  const RUN = "probe-run-1";
  const ranEvent = (kind: string, id = RUN) =>
    mac.heard.some(([m, p]) => m === "runEvent" && (p as { id: string; kind: string }).id === id && (p as { kind: string }).kind === kind);
  await client.requests.runBlock({ sessionId: "s1", id: RUN, code: "sleep 300", language: "sh" });
  for (let i = 0; i < 100 && !ranEvent("began"); i++) await Bun.sleep(100);
  check("an inline block is running on the far machine", ranEvent("began"));

  step("[two] a second device, alongside the first rather than instead of it");
  // What this used to do was hang up on the Mac. The phone now joins a daemon
  // that goes on serving both, and the checks are the two halves of that: what
  // each is answered, and what each is told.
  const phoneEars = ears();
  const phone = clientConnection(spawnDuplex(argv), {
    push: phoneEars.push,
    build: BUILD_VERSION,
    client: "probe-phone",
    label: "Probe iPhone",
    hold: ASK,
  });
  await phone.ready;

  // Presence, over the hop the labels had to cross (remote.md §7). The Mac was
  // told it was alone when it arrived, and is told again the moment the phone
  // does — which is what saves both of them a round trip asking.
  const listFor = (heard: Array<[string, unknown]>): PeerInfo[] | null =>
    heard
      .filter(([m]) => m === "presence")
      .map(([, p]) => (p as { others: PeerInfo[] }).others)
      .at(-1) ?? null;
  for (let i = 0; i < 100 && (listFor(mac.heard)?.length ?? 0) === 0; i++) await Bun.sleep(100);
  check(
    "the Mac is told the phone arrived, by name",
    listFor(mac.heard)?.[0]?.client === "probe-phone" && listFor(mac.heard)?.[0]?.label === "Probe iPhone",
    JSON.stringify(listFor(mac.heard)),
  );
  for (let i = 0; i < 100 && listFor(phoneEars.heard) === null; i++) await Bun.sleep(100);
  check(
    "and each is told about the other rather than about itself",
    listFor(phoneEars.heard)?.length === 1 && listFor(phoneEars.heard)?.[0]?.label === "Probe Studio",
    JSON.stringify(listFor(phoneEars.heard)),
  );
  const onPhone = await phone.requests.noteList({ root });
  check(
    "the phone is served the same notes",
    onPhone.notes.some((n) => n.title === "Over SSH"),
    `${onPhone.notes.length} note(s)`,
  );
  const stillMac = await client.requests.noteList({ root });
  check(
    "and the Mac was not hung up on to make room",
    stillMac.notes.length === onPhone.notes.length && client.farewell() === null,
    client.farewell() ?? "no goodbye",
  );

  // Notes in the other direction, and pushed rather than asked for: the listing
  // above only proves the phone can go and look. What makes a note open on the
  // Mac follow a save made on the phone is `notesChanged` arriving unprompted
  // (rpc-schema), and that watcher was written when the only writer to tell
  // about was an agent on the same machine.
  const macHeard = (m: string) => mac.heard.filter(([k]) => k === m).length;
  const before = macHeard("notesChanged");
  const { note: typed } = await phone.requests.noteCreate({
    root,
    text: "# From The Phone\n\ntyped on the small screen\n",
  });
  for (let i = 0; i < 100 && macHeard("notesChanged") === before; i++) await Bun.sleep(100);
  check(
    "a note the phone saves is pushed to the Mac unasked",
    macHeard("notesChanged") > before,
    `${macHeard("notesChanged") - before} notesChanged`,
  );
  // Deliberately NOT called "the reload that answers the push": this is a read,
  // and it passes with the watcher torn out, which is how the wording was
  // caught. Being TOLD is the check above; this is what is there to be read
  // once you are, down to the version an unedited buffer adopts as its own.
  const reload = await client.requests.noteRead({ path: typed.path });
  check(
    "and the Mac reads back the phone's text, at the phone's own mtime",
    (reload.note?.text ?? "").includes("typed on the small screen") && reload.note?.mtimeMs === typed.mtimeMs,
    `mtime ${reload.note?.mtimeMs} vs ${typed.mtimeMs}`,
  );

  // The one case that push cannot settle: both of them editing it, so neither
  // buffer may be reloaded and the second save arbitrates instead. Over ssh
  // because `divergedTo` is an answer the far client has to RECEIVE — one that
  // never crosses is a notice the sidebar never shows (mainview/notes/store.ts).
  const base = typed.mtimeMs;
  // Before the write that has to differ from `base`, not after: a filesystem
  // whose mtimes are coarse would otherwise hand back the same number and the
  // guard would see no divergence at all.
  await Bun.sleep(5);
  await client.requests.noteWrite({
    path: typed.path,
    text: "# From The Phone\n\nwhat the mac saved\n",
    baseMtimeMs: base,
  });
  const second = await phone.requests.noteWrite({
    path: typed.path,
    text: "# From The Phone\n\nwhat the phone saved\n",
    baseMtimeMs: base,
  });
  check(
    "the save that lands second is told where the version it displaced went",
    !!second.divergedTo,
    second.divergedTo ?? "nothing",
  );
  // No shell: the path is the server's own, and a cat through `sh -c` would be
  // one more place a filename gets to mean something.
  const displaced = run(["docker", "exec", NAME, "cat", second.divergedTo ?? "/nonexistent"], { quiet: true });
  check(
    "and the file it names holds the version that lost, whole",
    displaced.out.includes("what the mac saved"),
    displaced.out.split("\n").at(-1)?.slice(0, 40) ?? displaced.err.slice(0, 40),
  );

  // The phone's boot claim, against a server carrying somebody else's build.
  // Unscoped this interrupts it, and the only trace is a line in a log nobody
  // is reading (remote.md §7).
  const passedBy = await phone.requests.inlineClaim({ ids: [] });
  check(
    "a claim from another client collects nothing",
    passedBy.orphaned === 0 && passedBy.running.length === 0,
    `${passedBy.orphaned} orphaned, ${passedBy.running.length} confirmed`,
  );
  await Bun.sleep(1500);
  check("and the Mac's run is still running", !ranEvent("ended"));

  // Now the traffic, with both connections open, since the sleep above says
  // nothing while it runs and silence proves nothing about where it went. A
  // block and a drawer, both driven by the Mac: every byte of either has to
  // land on one screen and not the other (remote.md §7).
  const CHATTY = "probe-run-2";
  await client.requests.runBlock({ sessionId: "s1", id: CHATTY, code: "echo two-clients-one-server", language: "sh" });
  for (let i = 0; i < 100 && !ranEvent("ended", CHATTY); i++) await Bun.sleep(100);
  check("a block the Mac ran is reported to the Mac", ranEvent("ended", CHATTY));
  await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa("echo DRAWER-42\n") });
  for (let i = 0; i < 100 && !output().includes("DRAWER-42"); i++) await Bun.sleep(100);
  check("and the drawer it is attached to answers it", output().includes("DRAWER-42"));
  check(
    "while the phone is told about neither",
    phoneEars.heard.filter(([m]) => m === "runEvent" || m === "terminalOutput").length === 0,
    `${phoneEars.heard.map(([m]) => m).join(", ") || "nothing"} heard`,
  );

  // The drawer is the one thing the two cannot both have, so it changes hands
  // rather than being shared: the phone attaches, and what has to be true is
  // all three of the Mac being TOLD, the Mac's keystrokes being refused, and
  // the phone's reaching the shell. Against a real pty, because the refusal
  // that matters is the one where the bytes would otherwise have been written.
  await phone.requests.terminalAttach({ sessionId: "s1", host: null });
  check(
    "the Mac is told when the phone takes its drawer, and by whom",
    phoneEars.heard.every(([m]) => m !== "terminalDetached") &&
      mac.heard.some(
        ([m, p]) =>
          m === "terminalDetached" &&
          (p as { sessionId: string }).sessionId === "s1" &&
          // The id, which the list above turns into "Probe iPhone" on screen.
          (p as { by: string }).by === "probe-phone",
      ),
  );
  const typedOn = await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa("echo MAC-AFTER\n") });
  const sized = await client.requests.terminalResize({ sessionId: "s1", cols: 20, rows: 5 });
  check("and can no longer type into it or resize it", !typedOn.ok && !sized.ok, `input ${typedOn.ok}, resize ${sized.ok}`);
  const onPhoneNow = () =>
    phoneEars.heard
      .filter(([m]) => m === "terminalOutput")
      .map(([, p]) => atob((p as { dataB64: string }).dataB64))
      .join("");
  await phone.requests.terminalInput({ sessionId: "s1", dataB64: btoa("echo DRAWER-43\n") });
  for (let i = 0; i < 100 && !onPhoneNow().includes("DRAWER-43"); i++) await Bun.sleep(100);
  check(
    "while the phone's own reach the shell, and the Mac's never did",
    onPhoneNow().includes("DRAWER-43") && !onPhoneNow().includes("MAC-AFTER"),
  );

  phone.close();
  client.close();

  step("[hold] a session hold, asked over ssh and answered by a real daemon");
  check("the server states a ceiling in its handshake", hello.hold > 0, `${Math.round(hello.hold / 1000)}s`);
  check("and this client's ask fits inside it", sessionHold(ASK, hello.hold) === ASK, `asked ${Math.round(ASK / 1000)}s`);
  // Both clients that just left had a terminal session open between them, so
  // the daemon should have armed the hold rather than the ordinary minute
  // (ios.md §5). Its own log is the only place that decision is visible from
  // out here, and the ssh teardown has to reach it first.
  const wanted = `holding sessions for ${Math.round(sessionHold(ASK, hello.hold) / 1000)}s`;
  // The ssh user's own app home, which is not the image's `/data`: a daemon an
  // ssh conjured belongs to whoever the forced-command key authenticated as.
  const daemonLog = "/home/ledge/.ledge/logs/ledge-server.log";
  let armed = "";
  for (let i = 0; i < 30 && !armed.includes(wanted); i++) {
    await Bun.sleep(200);
    armed = run(["docker", "exec", NAME, "sh", "-c", `cat ${daemonLog} 2>&1`], { quiet: true }).out;
  }
  check(
    "the daemon armed the hold rather than the idle timeout",
    armed.includes(wanted),
    armed.includes(wanted) ? wanted : armed.trim().split("\n").slice(-1)[0]?.slice(0, 70),
  );

  step("[orphan] a run the page that started it can no longer show");
  // What a phone whose webview was killed leaves behind: a run still executing
  // on the far machine, started by a connection that is gone, with no id left
  // on this side to stop it by. A fresh connection claims nothing and the
  // daemon collects the difference (rpc-schema inlineClaim).
  const reboot = clientConnection(spawnDuplex(argv), { push: mac.push, build: BUILD_VERSION, client: "probe-mac", hold: ASK });
  const rebooted = await reboot.ready;
  // The claim only means anything against the server that still holds the run;
  // a restarted daemon would have taken the shells with it.
  check("the same daemon answered the new connection", rebooted.instance === hello.instance, rebooted.instance.slice(0, 8));
  const claimed = await reboot.requests.inlineClaim({ ids: [] });
  check(
    "it was still running the run nobody can show",
    claimed.orphaned === 1 && claimed.running.length === 0,
    `${claimed.orphaned} orphaned, ${claimed.running.length} confirmed`,
  );
  for (let i = 0; i < 100 && !ranEvent("ended"); i++) await Bun.sleep(100);
  check("and the interrupt reached the sleep through ssh and the pty", ranEvent("ended"));
  // Nothing left to orphan: the same question a second time finds the pool clear.
  check("a second claim finds nothing", (await reboot.requests.inlineClaim({ ids: [] })).orphaned === 0);
  reboot.close();

  step("[relink] a drawer whose wire dropped, and the shell that kept printing");
  // The train case, against a wire that can really drop (rpc-schema
  // terminalClaim): the shell goes on printing at a connection that is gone,
  // every one of those bytes is pushed at nobody, and the ring on the server is
  // the only place they still exist. A fresh session, since s1's drawer belongs
  // to the phone by now.
  const away = ears();
  const held0 = clientConnection(spawnDuplex(argv), { push: away.push, build: BUILD_VERSION, client: "probe-mac", hold: ASK });
  await held0.ready;
  await held0.requests.sessionConfigure({ sessionId: "s2", params: { cwd: root, env: {}, hosts: [] } as never, notePath: null });
  await held0.requests.terminalAttach({ sessionId: "s2", host: null });
  const printed = () =>
    away.heard
      .filter(([m]) => m === "terminalOutput")
      .map(([, p]) => atob((p as { dataB64: string }).dataB64))
      .join("");
  // Typed until it answers, for the [terminal] step's reason: zsh's line editor
  // resets the terminal as it comes up and discards whatever was pending.
  const ready = Date.now() + 15_000;
  while (Date.now() < ready && !printed().includes("SHELL-READY")) {
    await held0.requests.terminalInput({ sessionId: "s2", dataB64: btoa("echo SHELL-READY\n") });
    for (let i = 0; i < 12 && !printed().includes("SHELL-READY"); i++) await Bun.sleep(100);
  }
  check("a second drawer answered on the far machine", printed().includes("SHELL-READY"));
  // Printing AFTER the wire goes, which is the only way to produce output with
  // nobody there to receive it: a disconnected client cannot type, and no other
  // client may type into a drawer it does not own.
  await held0.requests.terminalInput({ sessionId: "s2", dataB64: btoa("sleep 2; echo WHILE-YOU-WERE-OUT\n") });
  held0.close();
  await held0.closed;
  await Bun.sleep(4000);

  const backEars = ears();
  const back = clientConnection(spawnDuplex(argv), { push: backEars.push, build: BUILD_VERSION, client: "probe-mac", hold: ASK });
  const backHello = await back.ready;
  check("the same daemon answered the new connection", backHello.instance === hello.instance, backHello.instance.slice(0, 8));
  const claim = await back.requests.terminalClaim({ sessionId: "s2" });
  check("the shell is still this client's, a dropped wire later", claim.state === "attached", claim.state);
  check(
    "and the claim carries what it printed while nobody was connected",
    claim.state === "attached" && atob(claim.dataB64).includes("WHILE-YOU-WERE-OUT"),
  );
  check(
    "which no push had delivered, because it was said at a connection that had gone",
    !backEars.heard
      .filter(([m]) => m === "terminalOutput")
      .map(([, p]) => atob((p as { dataB64: string }).dataB64))
      .join("")
      .includes("WHILE-YOU-WERE-OUT"),
  );

  // The other answer, and the one a reconnect that simply re-attached would get
  // wrong: a device that took the shell while this one was away keeps it.
  const took = clientConnection(spawnDuplex(argv), { push: ears().push, build: BUILD_VERSION, client: "probe-phone", label: "Probe iPhone", hold: ASK });
  await took.ready;
  back.close();
  await back.closed;
  await took.requests.terminalAttach({ sessionId: "s2", host: null });

  const third = clientConnection(spawnDuplex(argv), { push: ears().push, build: BUILD_VERSION, client: "probe-mac", hold: ASK });
  await third.ready;
  const moved = await third.requests.terminalClaim({ sessionId: "s2" });
  check(
    "a shell taken while the wire was down is reported, not taken back",
    moved.state === "held" && moved.by === "probe-phone",
    moved.state,
  );
  const stillTheirs = await took.requests.terminalInput({ sessionId: "s2", dataB64: btoa("echo STILL-THE-PHONES\n") });
  check("and the device that took it still has it", stillTheirs.ok);
  third.close();
  took.close();

  step("[drop] a wire that stops carrying bytes, and the ladder that climbs back");
  // The debt phase 5 recorded. Everything above proves a connection that ENDED
  // — a close, or a process killed — and both of those shut a pipe, which tells
  // this end immediately. A network that goes away does neither. It stops
  // carrying bytes and says nothing: no FIN, no RST, no exit. Until this step
  // nothing here had ever met one, and the first thing meeting one found was
  // that the client did not notice for two hours (connections.ts, the three
  // options above BatchMode).
  //
  // The instrument is `cutWire` above, which drops the fixture's replies and
  // nothing else — so the write below REACHES the far machine and is executed,
  // and only its answer is lost. That is the one condition bun/opLog.ts was
  // written for and the one the dedupe has never been asked about anywhere but
  // on a connection that was working perfectly.
  //
  // It is also the first thing here to drive reconnectingClient rather than one
  // connection. The ladder, the held requests, the replay under the same op and
  // the instance check are all its, and they had only ever climbed against a
  // duplex a test wrote (transport.test.ts).
  const states: string[] = [];
  const cutEars = ears();
  const ladder = await reconnectingClient({
    dial: () => spawnDuplex(argv),
    push: cutEars.push,
    build: BUILD_VERSION,
    client: "probe-mac",
    label: "Probe Studio",
    hold: ASK,
    onState: (s) => states.push(s),
  });
  await ladder.requests.sessionConfigure({ sessionId: "s3", params: { cwd: root, env: {}, hosts: [] } as never, notePath: null });
  await ladder.requests.terminalAttach({ sessionId: "s3", host: null });
  const inTheDark = () =>
    cutEars.heard
      .filter(([m]) => m === "terminalOutput")
      .map(([, p]) => atob((p as { dataB64: string }).dataB64))
      .join("");
  const answering = Date.now() + 15_000;
  while (Date.now() < answering && !inTheDark().includes("THIRD-READY")) {
    await ladder.requests.terminalInput({ sessionId: "s3", dataB64: btoa("echo THIRD-READY\n") });
    for (let i = 0; i < 12 && !inTheDark().includes("THIRD-READY"); i++) await Bun.sleep(100);
  }
  check("a third drawer answered on the far machine", inTheDark().includes("THIRD-READY"));

  // On a clock, and sent BEFORE the cut on purpose. What this line has to prove
  // is the far machine going on RUNNING while the network is gone, which is the
  // whole difference between losing a wire and losing a server; typing it into
  // a wire that was already cut would prove the replay instead.
  //
  // Arithmetic rather than a literal, for the [terminal] step's reason turned
  // to a new use: a pty ECHOES what is typed into it, so a token that appears in
  // the command appears in the output twice over — once before the cut, from the
  // echo. Both checks below passed on that echo the first time they were run,
  // which is a test proving the shell can repeat itself. Only the shell can say
  // 42.
  const DARK = "PRINTED-INTO-THE-42";
  await ladder.requests.terminalInput({ sessionId: "s3", dataB64: btoa("sleep 5; echo PRINTED-INTO-THE-$((6*7))\n") });

  cutWire();
  const cutAt = Date.now();
  console.log("  the wire is cut: the server's replies are dropped, and nothing tells this end");

  // Executed there, unanswerable here.
  const CUT_TITLE = "Cut Wire";
  let settled = "";
  const orphaned = ladder.requests.noteCreate({ root, text: `# ${CUT_TITLE}\n\nwritten with the answer thrown away\n` });
  void orphaned.then(
    () => (settled = "answered"),
    (err: Error) => (settled = `rejected: ${err.message}`),
  );
  // Asked through docker and not over the connection, because the point of the
  // question is that the connection cannot answer it. `ls` rather than a shell:
  // the path is the server's own (the [displaced] read above, same reason).
  const listing = () => run(["docker", "exec", NAME, "ls", root], { quiet: true }).out;
  let landed = false;
  for (let i = 0; i < 100 && !landed; i++) {
    await Bun.sleep(100);
    landed = /cut-wire/i.test(listing());
  }
  check("a write sent into the dark still runs on the far machine", landed, listing().split("\n").join(" ").slice(0, 60));
  check("while this end is told nothing at all about it", settled === "", settled || "still waiting");

  for (let i = 0; i < 400 && !states.includes("reconnecting"); i++) await Bun.sleep(100);
  check(
    "the client notices a wire that closed nothing",
    states.includes("reconnecting"),
    `${((Date.now() - cutAt) / 1000).toFixed(1)}s after the cut`,
  );

  // Held, not failed: a request made during the gap is what a person typing
  // through a tunnel that just died is doing, and failing it would surface as
  // an error for something that is about to work.
  let gapSettled = "";
  const duringTheGap = ladder.requests.noteList({ root });
  void duringTheGap.then(
    () => (gapSettled = "answered"),
    (err: Error) => (gapSettled = `rejected: ${err.message}`),
  );
  await Bun.sleep(500);
  check("a request made while it is down waits instead of failing", gapSettled === "", gapSettled || "held");

  mendWire();
  const mendedAt = Date.now();
  for (let i = 0; i < 400 && states.at(-1) !== "live"; i++) await Bun.sleep(100);
  check(
    "and the ladder climbs back when the wire returns",
    states.at(-1) === "live",
    `${((Date.now() - mendedAt) / 1000).toFixed(1)}s after mending, ${states.join(" → ")}`,
  );

  const carried = await Promise.race([
    Promise.all([orphaned, duringTheGap]).then(
      () => "both answered",
      (err: Error) => `failed: ${err.message}`,
    ),
    Bun.sleep(20_000).then(() => "never answered"),
  ]);
  check("the requests it was holding are answered by the connection that replaced the one that died", carried === "both answered", carried);

  // The payoff, and the thing a replay gets wrong if the op record is not
  // consulted: this write ran before the drop, so running it again would leave
  // two notes and the second one is the user's work duplicated.
  const after = await ladder.requests.noteList({ root });
  const made = after.notes.filter((n) => n.title === CUT_TITLE);
  check(
    "and the write replayed across the drop applied once, having already run before it",
    made.length === 1,
    `${made.length} notes named "${CUT_TITLE}"`,
  );

  const survived = await ladder.requests.terminalClaim({ sessionId: "s3" });
  check("the drawer is still this client's, a lost network later", survived.state === "attached", survived.state);
  check(
    "and the shell kept printing into it with nobody on the other end",
    survived.state === "attached" && atob(survived.dataB64).includes(DARK),
  );
  check(
    "which no push delivered, because the wire that would have carried it was gone",
    !inTheDark().includes(DARK),
  );
  ladder.close();

  step("[stall] a server that stops answering with nothing wrong below the protocol");
  // The cut above proves a client notices a wire that went away. This proves
  // the other half, and it is the half the phone had no answer to at all: a
  // wire that is fine and a SERVER that is not. `signalDaemon` says why nothing
  // underneath can see it.
  //
  // One connection rather than the ladder, because what is being read here is
  // the VERDICT and not the recovery. A held request never surfaces a reason
  // (that is the point of holding it), so the ladder can only ever show that
  // something happened; a plain connection fails its requests with the words
  // that say what.
  const pid = daemonPid();
  check("the far machine's daemon names its own pid beside its socket", /^\d+$/.test(pid), `pid ${pid || "none"}`);
  const stallEars = ears();
  const stalled = clientConnection(spawnDuplex(argv), { push: stallEars.push, build: BUILD_VERSION, client: "probe-mac" });
  await stalled.ready;
  await stalled.requests.noteList({ root });
  ok("a connection that is answering");

  signalDaemon("STOP");
  const stalledAt = Date.now();
  const verdict = await Promise.race([
    stalled.requests.noteList({ root }).then(
      () => "answered anyway",
      (err: Error) => err.message,
    ),
    Bun.sleep(60_000).then(() => "nothing was said in 60s"),
  ]);
  const noticedAfter = ((Date.now() - stalledAt) / 1000).toFixed(1);
  // Asked while the client is giving up rather than before it starts, because
  // the claim is about that moment: sshd is answering on the very machine the
  // client is about to hang up on.
  const stillListening = pickHostKey(run(["ssh-keyscan", "-T", "2", "127.0.0.1"], { quiet: true }).out);
  signalDaemon("CONT");
  check("sshd on that machine answered throughout, so nothing under the protocol had anything to notice", stillListening === hostKey);
  check("the client gives up on a server that stopped answering", /stopped answering/.test(verdict), `${noticedAfter}s: ${verdict}`);
  stalled.close();

  // And the daemon was only stopped, never killed: the same process is still
  // there with the notes it had, which is what makes this a stall rather than
  // the crash the instance check is for (remote.md §7).
  const resumed = clientConnection(spawnDuplex(argv), { push: ears().push, build: BUILD_VERSION, client: "probe-mac" });
  const resumedHello = await resumed.ready;
  check(
    "and it is the same run of the same daemon once it is running again",
    resumedHello.instance === hello.instance,
    `instance ${resumedHello.instance.slice(0, 8)}`,
  );
  resumed.close();

  /**
   * The password door, against sshd instances that take no keys at all
   * (remote.md §4).
   *
   * This is the step the section was rewritten for. Everything else about the
   * door is a string comparison in connections.test.ts, and one clause of §4
   * was a string comparison that agreed with itself and was WRONG about
   * OpenSSH: `BatchMode=yes` suppresses `SSH_ASKPASS` entirely, `force`
   * included, so the helper is never spawned and no password is ever offered.
   * The claim can only be settled here, so it is asserted here in both
   * directions — the argv the app builds connects, and the same argv with
   * BatchMode back on does not.
   *
   * Two sshd instances, because a password reaches OpenSSH by two different
   * code paths and a great many real servers use the second one. Each container
   * offers exactly one of them and no public key at all, so a connection that
   * comes up has proved which method carried it rather than merely that
   * something did.
   *
   * The password itself is realistic rather than convenient: shell-hostile
   * ASCII for the helper, which is a `/bin/sh` script, and one non-ASCII
   * character for the hex encoding `security` would otherwise mangle
   * (bun/secrets.ts).
   */
  step("[password] the other door, against sshd instances that take no keys");
  const PASSWORD = `pr0be "pass" $with 'quotes' und ümlaut`;
  const WRONG = "not-the-password";
  const right = `probe-password-${process.pid}`;
  const wrong = `probe-wrong-${process.pid}`;
  secrets.push(right, wrong);
  // Straight into the real keychain, because that is the seam under test: the
  // helper reads it with `security` and nothing in this process hands it over.
  const storedRight = await storePassword(right, PASSWORD);
  const storedWrong = await storePassword(wrong, WRONG);
  check("a password with quotes, spaces and a non-ascii character round-trips the keychain", storedRight.ok && storedWrong.ok, storedRight.error || storedWrong.error);
  const askpass = await ensureAskpass();
  ok("the askpass helper was written", askpass);

  for (const [method, port, suffix] of [
    ["password", 22022, "pw"],
    ["keyboard-interactive", 22023, "kbd"],
  ] as const) {
    const box = `${NAME}-${suffix}`;
    run(["docker", "rm", "-f", box], { quiet: true });
    run([
      ...["docker", "run", "-d", "--name", box, "-p", `127.0.0.1:${port}:22`],
      ...["-e", `LEDGE_PASSWORD=${PASSWORD}`, "-e", `LEDGE_AUTH=${method}`, FIXTURE],
    ]);

    // -p, because known_hosts indexes a non-default port as `[host]:port` and
    // a pin taken on the wrong shape matches nothing at connect time
    // (shared/connections.ts).
    let scanned = "";
    for (let i = 0; i < 40 && !pickHostKey(scanned); i++) {
      await Bun.sleep(250);
      scanned = run(["ssh-keyscan", "-T", "2", "-p", String(port), "127.0.0.1"], { quiet: true }).out;
    }
    const pinned = pickHostKey(scanned);
    if (!pinned) throw new Error(`the ${method} fixture's sshd never answered ssh-keyscan on ${port}`);

    const pwConn: Connection = {
      id: right,
      name: `Probe (${method})`,
      destination: "ledge@127.0.0.1",
      port,
      keyPath: "",
      auth: "password",
      hostKey: pinned,
      lastReached: 0,
    };
    const pwKnownHosts = join(SCRATCH, `known_hosts.${suffix}`);
    await writeFile(pwKnownHosts, knownHostsText([pwConn]));
    const dialed = sshDial(pwConn, { knownHosts: pwKnownHosts, userKnownHosts: "/dev/null", askpass });
    console.log(`  ${method}: ${dialed.argv.join(" ")}`);

    // The whole claim, in one handshake: askpass was spawned, it read the
    // keychain, the password crossed, sshd took it, and the command the CLIENT
    // asked for ran — there is no forced command on this door to run it for us
    // (§4a).
    const pwEars = ears();
    const viaPassword = clientConnection(spawnDuplex(dialed.argv, { env: dialed.env }), {
      push: pwEars.push,
      build: BUILD_VERSION,
      client: "probe-mac",
    });
    const pwHello = await viaPassword.ready;
    ok(`the protocol comes up over ${method}`, `instance ${pwHello.instance.slice(0, 8)}`);
    viaPassword.close();

    // And the measurement that reversed §4. Same argv, same environment, one
    // option back to what this document used to say was not negotiable.
    const batched = dialed.argv.map((a) => (a === "BatchMode=no" ? "BatchMode=yes" : a));
    const suppressed = run(batched, { quiet: true, env: dialed.env });
    check(`BatchMode=yes blocks the helper on ${method}`, suppressed.code !== 0, `exit ${suppressed.code}`);
    check(
      "and blocks it by never running it, rather than by refusing the answer",
      /permission denied|no supported authentication|authentication failed/i.test(suppressed.err),
      suppressed.err.split("\n").find((l) => /denied|authentication/i.test(l))?.slice(0, 60) ?? suppressed.err.slice(0, 60),
    );

    // A wrong password fails, and fails once. Without NumberOfPasswordPrompts
    // the helper is asked again for every attempt the server allows, which is
    // the unbounded prompting BatchMode used to be doing.
    const wrongDial = sshDial(
      { ...pwConn, id: wrong },
      { knownHosts: pwKnownHosts, userKnownHosts: "/dev/null", askpass },
    );
    const began = Date.now();
    const rejected = run(wrongDial.argv, { quiet: true, env: wrongDial.env });
    check(`a wrong password is refused on ${method}`, rejected.code !== 0, `exit ${rejected.code}`);
    check("and is not retried until the server gives up", Date.now() - began < 10_000, `${Date.now() - began}ms`);

    run(["docker", "rm", "-f", box], { quiet: true });
  }

  step("[container] the other deployment: PID 1 is the daemon, docker exec is the pump");
  run(["docker", "rm", "-f", `${NAME}-plain`], { quiet: true });
  run(["docker", "run", "-d", "--name", `${NAME}-plain`, IMAGE]);
  await Bun.sleep(1500);
  const viaExec = clientConnection(spawnDuplex(["docker", "exec", "-i", `${NAME}-plain`, "ledge-server", "serve"]), {
    push: mac.push,
    build: BUILD_VERSION,
    client: "probe-mac",
  });
  const hello2 = await viaExec.ready;
  ok("handshake through docker exec", `instance ${hello2.instance.slice(0, 8)}`);
  const socketOwner = run(["docker", "exec", `${NAME}-plain`, "sh", "-c", "cat /data/.server.pid"], { quiet: true });
  check("the daemon is PID 1, not one serve started", socketOwner.out.trim() === "1", `pid ${socketOwner.out.trim()}`);
  viaExec.close();
  run(["docker", "rm", "-f", `${NAME}-plain`], { quiet: true });

  console.log(failures === 0 ? "\nAll claims held." : `\n${failures} claim(s) failed.`);
} finally {
  await teardown();
  console.log(`[-] container removed, scratch home removed (${SCRATCH})`);
}
process.exit(failures === 0 ? 0 : 1);
