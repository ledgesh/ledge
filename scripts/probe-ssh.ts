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
// It uses Ledge's OWN modules for everything it is testing: sshCommand builds
// the argv, pickHostKey chooses what to pin, knownHostsText writes the file,
// clientConnection speaks the protocol. A probe that hand-wrote an ssh command
// line would prove that ssh works, which was never in doubt.
//
// Run it: `bun run probe:ssh`. It builds two images, holds 127.0.0.1:22 for a
// few seconds, and removes everything it made.
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = await mkdtemp(join(tmpdir(), "ledge-ssh-probe-"));
// Before any Ledge module loads: importing the client modules derives the
// client home from APP_HOME, and a probe must never touch the real ~/.ledge
// (testing.md §6).
process.env["LEDGE_NOTES_ROOT"] = join(SCRATCH, "home");

const { sshCommand, pickHostKey, knownHostsText } = await import("../src/bun/connections");
type Connection = import("../src/bun/connections").Connection;
const { clientConnection, spawnDuplex } = await import("../src/bun/transport");
const { PUSH_MESSAGES } = await import("../src/shared/wire");
const { BUILD_VERSION } = await import("../src/shared/version");
type ServerPush = import("../src/bun/server").ServerPush;

const REPO = join(import.meta.dir, "..");
const IMAGE = "ledge-server:probe";
const FIXTURE = "ledge-sshd:probe";
const NAME = "ledge-ssh-probe";

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

async function teardown() {
  run(["docker", "rm", "-f", NAME], { quiet: true });
  await rm(SCRATCH, { recursive: true, force: true });
}

try {
  // Port 22 and not a high one: sshCommand takes a DESTINATION, and an ssh
  // destination has no port in it (the same constraint testing.md §6 records
  // for `host:` shells). Loopback only, and gone at teardown.
  const held = run(["sh", "-c", "lsof -nP -iTCP@127.0.0.1:22 -sTCP:LISTEN 2>/dev/null | tail -n +2"], { quiet: true });
  if (held.out) throw new Error(`something already listens on 127.0.0.1:22:\n${held.out}\nStop it, or run this elsewhere.`);

  step("[build] the shipped image, then the fixture that adds an sshd to it");
  run(["docker", "build", "-t", IMAGE, REPO]);
  run(["docker", "build", "--build-arg", `BASE=${IMAGE}`, "-t", FIXTURE, join(import.meta.dir, "ssh-probe")]);
  console.log(`  ${IMAGE} and ${FIXTURE} built`);

  step("[key] a throwaway pair, offered under the forced command");
  const keyPath = join(SCRATCH, "id_ed25519");
  run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "ledge-probe", "-f", keyPath]);
  const pub = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  run(["docker", "run", "-d", "--name", NAME, "-p", "127.0.0.1:22:22", "-e", `LEDGE_PUBKEY=${pub}`, FIXTURE]);
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

  const conn: Connection = {
    id: "probe",
    name: "Probe",
    // user@host, because a bare host makes ssh offer the LOCAL username and
    // the account on the other side is the one that owns the notes. Getting
    // this wrong is a plain "Permission denied (publickey)", which is also
    // what a wrong key looks like — worth knowing before it happens to a user.
    destination: "ledge@127.0.0.1",
    keyPath,
    hostKey,
    lastReached: 0,
  };
  const knownHosts = join(SCRATCH, "known_hosts");
  await writeFile(knownHosts, knownHostsText([conn]));
  // /dev/null for the user's own file: this probe has no business reading, and
  // certainly none writing, the developer's ~/.ssh/known_hosts.
  const argv = sshCommand(conn, knownHosts, "/dev/null");
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
  const refused = run(sshCommand(conn, badPin, "/dev/null"), { quiet: true });
  check("a wrong pin refuses the connection", refused.code !== 0, `exit ${refused.code}`);
  const said = refused.err.split("\n").find((l) => /host key|verification failed/i.test(l)) ?? "";
  check("and says why", said.length > 0, said.slice(0, 66));
  check("with nothing offering to continue anyway", !/yes\/no|continue connecting/i.test(refused.err));

  step("[connect] the protocol over ssh");
  const heard: Array<[string, unknown]> = [];
  const push = Object.fromEntries(
    PUSH_MESSAGES.map((m) => [m, (p: unknown) => heard.push([m, p])]),
  ) as unknown as ServerPush;
  const client = clientConnection(spawnDuplex(argv), { push, build: BUILD_VERSION, client: "probe-mac" });
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
    heard
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
  client.close();

  step("[container] the other deployment: PID 1 is the daemon, docker exec is the pump");
  run(["docker", "rm", "-f", `${NAME}-plain`], { quiet: true });
  run(["docker", "run", "-d", "--name", `${NAME}-plain`, IMAGE]);
  await Bun.sleep(1500);
  const viaExec = clientConnection(spawnDuplex(["docker", "exec", "-i", `${NAME}-plain`, "ledge-server", "serve"]), {
    push,
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
