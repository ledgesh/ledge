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

const { sshCommand, pickHostKey, knownHostsText } = await import("../src/bun/connections");
type Connection = import("../src/bun/connections").Connection;
const { clientConnection } = await import("../src/shared/transport");
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

async function teardown() {
  run(["docker", "rm", "-f", NAME], { quiet: true });
  await rm(SCRATCH, { recursive: true, force: true });
}

try {
  // Port 22 and not a high one: sshCommand takes a DESTINATION, and an ssh
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
  run(["docker", "run", "-d", "--name", NAME, "-p", SERVE ? "22:22" : "127.0.0.1:22:22", "-e", `LEDGE_PUBKEY=${pub}`, FIXTURE]);
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
  Ctrl-C takes the fixture down and removes it.
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
