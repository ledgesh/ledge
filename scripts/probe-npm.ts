#!/usr/bin/env bun
// The published package, on a machine that could not have built it.
//
// This is the claim `scripts/build-npm.ts` exists to make and the one no unit
// test can reach: that `bun add -g ledge-server` on a bare Linux box produces a
// working server, PTY trampolines included. The container is chosen for what it
// does NOT have — no compiler, no libc headers — because that is what makes the
// result unambiguous. pty.ts has two ways to get its trampolines (a prebuilt
// library, or compiling the same source in-process with TinyCC), and only the
// first can possibly work here. A shell that gets a controlling terminal in
// this container therefore proves the packaged library loaded, which is exactly
// what `bun test` cannot say from a checkout that has Xcode.
//
// It uses Ledge's own client to talk to it (`clientConnection` over
// `docker exec -i ... ledge-server serve`), for probe-ssh.ts's reason: a probe
// that hand-rolled the protocol would prove that Docker works.
//
// Run it: `bun run probe:npm`, after `bun run build:npm`.
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = await mkdtemp(join(tmpdir(), "ledge-npm-probe-"));
// Before any Ledge module loads, per testing.md §6: importing the client
// modules derives the client home from APP_HOME, and a probe must never touch
// the real ~/.ledge.
process.env["LEDGE_NOTES_ROOT"] = join(SCRATCH, "home");

const { clientConnection } = await import("../src/shared/transport");
const { spawnDuplex } = await import("../src/bun/transport");
const { PUSH_MESSAGES } = await import("../src/shared/wire");
const { BUILD_VERSION } = await import("../src/shared/version");
const { PACKAGE_NAME } = await import("../src/bun/npmPackage");
type ServerPush = import("../src/shared/wire").ServerPush;

const REPO = join(import.meta.dir, "..");
const OUT = join(REPO, "dist-npm");
const NAME = "ledge-npm-probe";
// Bun's own image: a runtime, deliberately. It carries bun and the shared
// libraries bun needs, and no toolchain — which is the whole fixture.
const IMAGE = "oven/bun:1-debian";

let failures = 0;
const ok = (claim: string, detail = "") => console.log(`  ok    ${claim}${detail && `  (${detail})`}`);
const bad = (claim: string, detail = "") => {
  failures++;
  console.log(`  FAIL  ${claim}${detail && `  (${detail})`}`);
};
const check = (claim: string, cond: boolean, detail = "") => (cond ? ok(claim, detail) : bad(claim, detail));
const step = (s: string) => console.log(`\n${s}`);

function run(cmd: string[], opts: { quiet?: boolean } = {}) {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  const err = p.stderr.toString().trim();
  if (p.exitCode !== 0 && !opts.quiet) throw new Error(`${cmd.slice(0, 3).join(" ")}… exited ${p.exitCode}\n${err || out}`);
  return { code: p.exitCode, out, err };
}

const inside = (...argv: string[]) => run(["docker", "exec", NAME, ...argv], { quiet: true });

async function teardown() {
  run(["docker", "rm", "-f", NAME], { quiet: true });
  await rm(SCRATCH, { recursive: true, force: true });
}

try {
  step("[pack] the tarball a publish would upload");
  if (!existsSync(join(OUT, "package.json"))) {
    console.error(`no package in dist-npm/. Run \`bun run build:npm\` first.`);
    process.exit(2);
  }
  // npm pack rather than a tar of our own: what ships is whatever npm decides
  // to include, so the thing under test has to be npm's output.
  const packed = run(["npm", "pack", OUT, "--pack-destination", SCRATCH]).out.split("\n").pop()!.trim();
  const tarball = join(SCRATCH, packed);
  ok("npm pack", packed);

  step("[fixture] a Linux machine with bun and no way to compile anything");
  run(["docker", "rm", "-f", NAME], { quiet: true });
  run([
    "docker", "run", "-d", "--name", NAME,
    "-e", "LEDGE_NOTES_ROOT=/data",
    IMAGE, "sleep", "infinity",
  ]);
  // zsh because settings.jsonc's default shell is zsh and this image has none,
  // which is the same reason the real `Dockerfile` installs it. Without it the
  // terminal claims below fail for a reason that has nothing to do with the
  // package.
  const zsh = inside("sh", "-c", "apt-get update -qq && apt-get install -y -qq --no-install-recommends zsh 2>&1 | tail -1");
  check("zsh installed, since that is the default shell", inside("sh", "-c", "command -v zsh").out !== "", zsh.out.slice(0, 60));

  // Asserted rather than assumed, and asserted AFTER the apt-get above so it
  // is the fixture's real final state. If a compiler or the headers were
  // present, every claim below could be satisfied by the in-process fallback
  // and the probe would prove nothing about the package.
  const cc = inside("sh", "-c", "command -v cc; command -v gcc; command -v tcc");
  check("no C compiler on PATH", cc.out === "", cc.out || "none");
  const hdr = inside("sh", "-c", "test -e /usr/include/sys/ioctl.h && echo present || echo absent");
  check("no libc headers either", hdr.out === "absent", hdr.out);
  ok("so the in-process fallback cannot rescue this", "only a prebuilt library can work here");

  step("[install] the one command the README gives");
  run(["docker", "cp", tarball, `${NAME}:/tmp/pkg.tgz`]);
  const add = inside("bun", "add", "-g", "/tmp/pkg.tgz");
  check(`bun add -g ${PACKAGE_NAME}`, add.code === 0, add.err.split("\n").slice(-1)[0] ?? "");

  // Bun puts global commands beside itself, so where they land is decided by
  // how Bun was installed rather than by anything in the package. This image is
  // the system-wide shape (bun in /usr/local/bin), which is the one where the
  // install needs no second step. The user-local shape puts BOTH bun and
  // ledge-server under ~/.bun/bin, which an incoming ssh will not find, and
  // that is what the manual's `command -v` check is for.
  const globalBin = inside("bun", "pm", "bin", "-g").out;
  ok("bun's global bin", globalBin);

  // THE condition the manual states, checked the way the manual says to check
  // it: an ssh command runs with a minimal PATH and no profile, so both names
  // have to resolve there or the client cannot start a server at all.
  //
  // One name per call, because `command -v` takes one — a two-name call
  // reports the first and says nothing about the second, which is a check that
  // passes while half of what it claims is untrue.
  const SSH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const onSshPath = (name: string) =>
    inside("env", "-i", `PATH=${SSH_PATH}`, "sh", "-c", `command -v ${name}`).out;
  const server = onSshPath("ledge-server");
  check("an ssh-shaped PATH finds ledge-server", server.endsWith("/ledge-server"), server || "not found");
  const theBun = onSshPath("bun");
  check("and the bun its shebang names", theBun.endsWith("/bun"), theBun || "not found");

  step("[start] the daemon, from the installed package");
  inside("sh", "-c", "mkdir -p /data");
  // `docker exec -d` rather than a backgrounded shell: a process left running
  // by an exec that has returned is not guaranteed to survive it.
  // --autostart off, because this daemon was asked for (remote.md §11).
  run(["docker", "exec", "-d", NAME, "sh", "-c", "ledge-server daemon > /tmp/daemon.log 2>&1"]);
  for (let i = 0; i < 100; i++) {
    if (inside("sh", "-c", "test -S /data/.server.sock && echo up").out === "up") break;
    await Bun.sleep(100);
  }
  const up = inside("sh", "-c", "test -S /data/.server.sock && echo up").out === "up";
  check("the daemon is listening", up, up ? "" : inside("cat", "/tmp/daemon.log").out.slice(0, 200));
  if (!up) throw new Error("the daemon never came up; the log is above");

  step("[protocol] Ledge's own client, over docker exec");
  const heard: Array<[string, unknown]> = [];
  const push = Object.fromEntries(
    PUSH_MESSAGES.map((m) => [m, (p: unknown) => heard.push([m, p])]),
  ) as unknown as ServerPush;
  const client = clientConnection(
    spawnDuplex(["docker", "exec", "-i", NAME, "ledge-server", "serve"]),
    { push, build: BUILD_VERSION, client: "probe-npm", label: "Probe", hold: 60_000 },
  );
  const hello = await client.ready;
  ok("handshake", `ledge-server ${hello.build}, instance ${hello.instance.slice(0, 8)}`);
  check("the package reports the version it was built from", hello.build === BUILD_VERSION, hello.build);

  step("[pty] the trampolines, which is what the package exists to carry");
  const { root } = await client.requests.workspaceCreate({ name: "Probe" });
  await client.requests.sessionConfigure({
    sessionId: "s1",
    params: { cwd: root, env: {}, hosts: [] } as never,
    notePath: null,
  });
  await client.requests.terminalAttach({ sessionId: "s1", host: null });
  const output = () =>
    heard
      .filter(([m]) => m === "terminalOutput")
      .map(([, p]) => atob((p as { dataB64: string }).dataB64))
      .join("");

  async function type(text: string, want: RegExp, ms = 15_000): Promise<string> {
    const deadline = Date.now() + ms;
    let seen = output();
    while (Date.now() < deadline && !want.test(seen)) {
      await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa(text) });
      for (let i = 0; i < 12 && !want.test(seen); i++) {
        await Bun.sleep(100);
        seen = output();
      }
    }
    return seen;
  }

  // ledge_spawn_tty: a shell at all.
  const ran = await type("echo PTY-$((6*7))\n", /PTY-42/);
  check("a shell spawned and answered", /PTY-42/.test(ran));

  // ledge_set_winsize, and THE discriminator: TIOCSWINSZ is variadic, so the
  // trampoline is the only way to reach it and nothing else in the fallback
  // substitutes. This claim failing is what a package missing its library for
  // this architecture looks like from the user's side.
  await client.requests.terminalResize({ sessionId: "s1", cols: 100, rows: 20 });
  const sized = await type('echo SIZE-$(stty size | tr " " "-")\n', /SIZE-20-100/);
  check("a resize reached the pty's winsize", /SIZE-20-100/.test(sized), JSON.stringify(sized.slice(-60)));

  // Job control end to end. This one is NOT a discriminator and is labelled so
  // it cannot be read as one: running this probe with the library removed
  // showed ^C still working, because the fallback spawn is a session leader
  // that opens the slave without O_NOCTTY and therefore acquires a controlling
  // terminal anyway (bun/pty.ts says so now; it used to claim the opposite).
  // It stays because a terminal that cannot be interrupted is worth catching
  // whatever the cause.
  //
  // Two things have to be established, and the first one is why this is not
  // three lines. A `sleep` that never started would make the ^C check pass
  // having tested nothing, and a keystroke lost to zsh's line editor is exactly
  // how that happens — so the job is first PROVEN to be holding the foreground.
  //
  // Every marker is arithmetic for the same reason: the line discipline echoes
  // what is typed whether or not the shell is running it, so a literal string
  // would appear in the output either way. `$((11*9))` reaches the transcript
  // as itself, and `99` only if a shell evaluated it.
  await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa("sleep 300\n") });
  await Bun.sleep(1000);
  await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa("echo NOPE-$((11*9))\n") });
  await Bun.sleep(2500);
  const blocked = !output().includes("NOPE-99");
  check("a foreground job is holding the shell", blocked, blocked ? "sleep 300 is running" : "the sleep never started");

  await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa("\x03") });
  const after = await type("echo AFTER-$((6*7))\n", /AFTER-42/, 10_000);
  check("and Ctrl-C interrupted it", /AFTER-42/.test(after), /AFTER-42/.test(after) ? "" : "the shell never came back");

  // The direct reading of the same fact, from the other side.
  const log = inside("cat", "/tmp/daemon.log").out;
  check("and the daemon never warned about its trampolines", !log.includes("[pty]"),
    log.split("\n").filter((l) => l.includes("[pty]")).join(" | ").slice(0, 100));

  step("[done]");
  client.close();
} catch (err) {
  bad("the probe threw", (err as Error).message);
} finally {
  await teardown();
}

const leftover = run(["docker", "ps", "-aq", "--filter", `name=${NAME}`], { quiet: true }).out;
check("the container is gone", leftover === "", leftover);
check("and the scratch root with it", !existsSync(SCRATCH));

console.log(failures === 0 ? "\nAll claims held." : `\n${failures} claim(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
