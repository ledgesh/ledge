#!/usr/bin/env bun
// The server release installed the way the manual says, on machines with no Bun
// (remote.md §13): server.sh piped into sh on Debian and Ubuntu, then dialled
// through a real sshd by Ledge's own client, with a Mac's command and under a
// phone's forced command. On a Mac it also installs into a scratch HOME. The
// registry is a directory; run `bun run build:server -- --targets=<these>` first.
import { mkdtemp, rm } from "node:fs/promises";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRATCH = await mkdtemp(join(tmpdir(), "ledge-install-probe-"));
// Before any Ledge module loads, per testing.md §6.
process.env["LEDGE_NOTES_ROOT"] = join(SCRATCH, "client");

const { clientConnection } = await import("../src/shared/transport");
const { spawnDuplex } = await import("../src/bun/transport");
const { PUSH_MESSAGES } = await import("../src/shared/wire");
const { BUILD_VERSION } = await import("../src/shared/version");
const { sshDial, pickHostKey, knownHostsText, SERVE_COMMAND } = await import("../src/bun/connections");
const { BUN_PACKAGES, BUN_VERSION, renderInstallScript, serverTarball, tarballPath } = await import("../src/bun/serverRelease");
type ServerPush = import("../src/shared/wire").ServerPush;
type Connection = import("../src/bun/connections").Connection;
type NativeTarget = import("../src/bun/npmPackage").NativeTarget;

const REPO = join(import.meta.dir, "..");
const DIST = join(REPO, "dist-server");
const BUN_CACHE = join(REPO, "dist-bun", `bun-v${BUN_VERSION}`);
const RELEASE = join(SCRATCH, "release");
const version = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }).version;
// The "newer" release the update step installs: the same tarball under another
// version, which is all the script can tell apart.
const NEXT = `${version}-probe.2`;
const IMAGES = [
  { image: "debian:12", shell: "/bin/bash", update: true },
  { image: "ubuntu:20.04", shell: "/usr/bin/zsh", update: false },
];

let failures = 0;
const ok = (claim: string, detail = "") => console.log(`  ok    ${claim}${detail && `  (${detail})`}`);
const bad = (claim: string, detail = "") => {
  failures++;
  console.log(`  FAIL  ${claim}${detail && `  (${detail})`}`);
};
const check = (claim: string, cond: boolean, detail = "") => (cond ? ok(claim, detail) : bad(claim, detail));
const step = (s: string) => console.log(`\n${s}`);

function run(cmd: string[], opts: { quiet?: boolean; stdin?: string; env?: Record<string, string> } = {}) {
  const p = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  const out = p.stdout.toString().trim();
  const err = p.stderr.toString().trim();
  if (p.exitCode !== 0 && !opts.quiet) throw new Error(`${cmd.slice(0, 4).join(" ")}… exited ${p.exitCode}\n${err || out}`);
  return { code: p.exitCode, out, err };
}

const ears = () => {
  const heard: Array<[string, unknown]> = [];
  const push = Object.fromEntries(PUSH_MESSAGES.map((m) => [m, (p: unknown) => heard.push([m, p])])) as unknown as ServerPush;
  return { heard, push };
};

/** `as` is the client id, and it matters: a second connection under the same id replaces the first. */
async function connect(as: string, argv: string[], env?: Record<string, string>) {
  const e = ears();
  const client = clientConnection(spawnDuplex(argv, env ? { env } : undefined), {
    push: e.push,
    build: BUILD_VERSION,
    client: as,
  });
  const hello = await Promise.race([
    client.ready,
    Bun.sleep(30_000).then(() => {
      throw new Error("no handshake within 30s");
    }),
  ]);
  return { client, hello, heard: e.heard };
}

/** A shell, a resize, an interrupt and a ```ts block: what the private Bun and the trampolines exist for. */
async function drive(where: string, c: Awaited<ReturnType<typeof connect>>) {
  const { client, heard } = c;
  const { root } = await client.requests.workspaceCreate({ name: "Probe" });
  await client.requests.sessionConfigure({ sessionId: "s1", params: { cwd: root, env: {}, hosts: [] } as never, notePath: null });
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

  check(`${where}: a shell spawned and answered`, /PTY-42/.test(await type("echo PTY-$((6*7))\n", /PTY-42/)));
  // The discriminator for the trampolines, per probe-npm.ts: nothing else reaches TIOCSWINSZ.
  await client.requests.terminalResize({ sessionId: "s1", cols: 100, rows: 20 });
  check(`${where}: a resize reached the pty`, /SIZE-20-100/.test(await type('echo SIZE-$(stty size | tr " " "-")\n', /SIZE-20-100/)));
  await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa("sleep 300\n") });
  await Bun.sleep(1000);
  await client.requests.terminalInput({ sessionId: "s1", dataB64: btoa("\x03") });
  check(`${where}: Ctrl-C interrupted a foreground job`, /AFTER-42/.test(await type("echo AFTER-$((6*7))\n", /AFTER-42/, 10_000)));

  // The reason the script installs a Bun at all: a ```ts fence runs on the server
  // with no bun on its PATH (runner.ts, bundledBun).
  const id = "probe-ts";
  await client.requests.runBlock({ sessionId: "s1", id, code: 'console.log("TS-" + 6 * 7, Bun.version)', language: "ts" });
  const events = () => heard.filter(([m, p]) => m === "runEvent" && (p as { id: string }).id === id).map(([, p]) => p as { kind: string; dataB64?: string; exitCode?: number | null });
  for (let i = 0; i < 150 && !events().some((e) => e.kind === "ended"); i++) await Bun.sleep(100);
  const said = events().filter((e) => e.kind === "output").map((e) => atob(e.dataB64 ?? "")).join("");
  const ended = events().find((e) => e.kind === "ended");
  check(`${where}: a ts block ran on the Bun the script installed`, said.includes(`TS-42 ${BUN_VERSION}`) && ended?.exitCode === 0, JSON.stringify(said.trim().slice(-40)));
}

/**
 * A registry in RELEASE/registry laid out the way npm serves one: dist-server's
 * tarball under this version and NEXT, and the pinned Bun for each target
 * build:server downloaded. The scripts are the ones a release renders, with
 * only the registry changed, so `curl | sh` reads files rather than npm.
 */
function stageRelease(linux: NativeTarget, mac: NativeTarget | null) {
  const place = (from: string, path: string) => {
    mkdirSync(dirname(join(RELEASE, "registry", path)), { recursive: true });
    copyFileSync(from, join(RELEASE, "registry", path));
  };
  const tarball = join(DIST, serverTarball(version));
  place(tarball, tarballPath("ledge-server", version));
  place(tarball, tarballPath("ledge-server", NEXT));
  for (const t of [linux, mac]) {
    if (!t) continue;
    const path = tarballPath(BUN_PACKAGES[`${t.platform}-${t.arch}`]!.name, BUN_VERSION);
    if (!existsSync(join(BUN_CACHE, path))) throw new Error(`dist-bun/ has no ${path}. Run \`bun run build:server -- --targets=${t.platform}-${t.arch}\`.`);
    place(join(BUN_CACHE, path), path);
  }
  const template = readFileSync(join(REPO, "release", "server.sh"), "utf8");
  const serverSum = new Bun.CryptoHasher("sha256").update(readFileSync(tarball)).digest("hex");
  mkdirSync(join(RELEASE, "next"), { recursive: true });
  writeFileSync(join(RELEASE, "server.sh"), renderInstallScript(template, { version, registry: "file:///release/registry", serverSum }));
  writeFileSync(join(RELEASE, "server-mac.sh"), renderInstallScript(template, { version, registry: `file://${RELEASE}/registry`, serverSum }));
  writeFileSync(join(RELEASE, "next", "server.sh"), renderInstallScript(template, { version: NEXT, registry: "file:///release/registry", serverSum }));
}

async function linuxMachine(image: string, shell: string, update: boolean) {
  const name = `ledge-install-probe-${image.replace(/[^a-z0-9]/g, "-")}`;
  const inside = (cmd: string, opts: { stdin?: string } = {}) => run(["docker", "exec", ...(opts.stdin ? ["-i"] : []), name, "sh", "-c", cmd], { quiet: true, ...opts });
  const asLedge = (cmd: string) => run(["docker", "exec", "-u", "ledge", "-e", "HOME=/home/ledge", name, "sh", "-c", cmd], { quiet: true });
  const home = "/home/ledge/.ledge-server";
  try {
    step(`[${image}] a machine with sshd and no Bun`);
    run(["docker", "rm", "-f", name], { quiet: true });
    run(["docker", "run", "-d", "--name", name, "-p", "127.0.0.1::22", "-v", `${RELEASE}:/release:ro`, image, "sleep", "infinity"]);
    const apt = inside(
      "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-server curl ca-certificates sudo zsh >/dev/null 2>&1",
    );
    check("openssh-server, curl, sudo and zsh installed", apt.code === 0, apt.err.slice(-80));
    inside(`useradd --create-home --shell ${shell} ledge && mkdir -p /run/sshd && ssh-keygen -A && /usr/sbin/sshd`);
    const libc = inside("getconf GNU_LIBC_VERSION").out;
    const bun = inside("command -v bun; su - ledge -c 'command -v bun'").out;
    check("no bun anywhere on it", bun === "", bun || libc);

    step(`[${image}] the install`);
    const asRoot = inside("curl -fsSL file:///release/server.sh | sh");
    check("root is refused", asRoot.code !== 0 && asRoot.err.includes("not as root"), asRoot.err.split("\n")[0]?.slice(0, 70));
    check("and nothing was written for root", inside("test -e /root/.ledge-server && echo yes").out === "");
    // The command the refusal itself suggests, so the sentence is known to work.
    const installed = inside("curl -fsSL file:///release/server.sh | sudo -iu ledge sh");
    check("`curl … | sudo -iu ledge sh` installs it", installed.code === 0 && installed.out.includes(`ledge-server ${version} is installed in ${home}.`), (installed.err || installed.out.split("\n").pop() || "").slice(0, 80));
    check("with no warning about sshd", !installed.out.includes("Warning"), installed.out.split("\n").find((l) => l.includes("Warning")) ?? "");
    const shipped = asLedge(`${home}/versions/${version}/bun --version`).out;
    check("the private Bun runs here", shipped === BUN_VERSION, `${shipped || "did not run"} on ${libc}`);
    const rc = shell.endsWith("zsh") ? ".zshrc" : ".bashrc";
    const found = run(["docker", "exec", "-u", "ledge", "-e", "HOME=/home/ledge", "-w", "/home/ledge", name, shell, "-ic", "command -v ledge"], { quiet: true }).out.split("\n").pop();
    check(`a new ${shell.split("/").pop()} terminal finds ledge through ~/${rc}`, found === `${home}/bin/ledge`, found);

    step(`[${image}] Ledge's clients, through sshd`);
    const port = Number(run(["docker", "port", name, "22/tcp"]).out.split("\n")[0]!.split(":").pop());
    const keys = join(SCRATCH, name);
    mkdirSync(keys, { recursive: true });
    for (const k of ["mac", "phone"]) run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `probe-${k}`, "-f", join(keys, k)]);
    const pub = (k: string) => readFileSync(join(keys, `${k}.pub`), "utf8").trim();
    const authorized = `restrict,command="${SERVE_COMMAND}" ${pub("phone")}\n${pub("mac")}\n`;
    run(["docker", "exec", "-i", "-u", "ledge", name, "sh", "-c", "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"], { stdin: authorized });
    let scan = "";
    for (let i = 0; i < 40 && !pickHostKey(scan); i++) {
      scan = run(["ssh-keyscan", "-T", "2", "-p", String(port), "127.0.0.1"], { quiet: true }).out;
      if (!pickHostKey(scan)) await Bun.sleep(250);
    }
    const hostKey = pickHostKey(scan);
    if (!hostKey) throw new Error("sshd never answered ssh-keyscan");
    const dial = (k: string) => {
      const conn: Connection = { id: k, name: k, destination: "ledge@127.0.0.1", port, keyPath: join(keys, k), auth: "key", hostKey, lastReached: 0 };
      const knownHosts = join(keys, "known_hosts");
      writeFileSync(knownHosts, knownHostsText([conn]));
      return sshDial(conn, { knownHosts, userKnownHosts: "/dev/null", askpass: "" }).argv;
    };
    const macArgv = dial("mac");
    // What makes the prefix necessary: the PATH sshd gives a command does not have it.
    const bare = run([...macArgv.slice(0, -1), "command -v ledge || echo not-found"], { quiet: true }).out;
    check("sshd's own PATH does not find ledge", bare === "not-found", bare);

    const mac = await connect("probe-mac", macArgv);
    check("the Mac's command reaches the installed server", mac.hello.build === BUILD_VERSION, `build ${mac.hello.build}`);
    const phone = await connect("probe-phone", dial("phone"));
    check("and so does a phone's forced command", phone.hello.build === BUILD_VERSION, `build ${phone.hello.build}`);
    phone.client.close();

    const daemon = () => {
      const procs = inside("for p in /proc/[0-9]*; do printf '%s ' \"${p#/proc/}\"; tr '\\0' ' ' < \"$p/cmdline\"; echo; done 2>/dev/null").out;
      const line = procs.split("\n").find((l) => l.includes(" daemon --autostart"));
      return line ? { pid: line.split(" ")[0]!, args: line.slice(line.indexOf(" ") + 1).trim() } : null;
    };
    const first = daemon();
    const expected = (v: string) => `${home}/versions/${v}/bun ${home}/versions/${v}/bin/ledge.js daemon --autostart`;
    check("the daemon started itself, from the private Bun", first?.args === expected(version), first?.args ?? "no daemon");

    await drive(image, mac);
    const log = asLedge("cat ~/.ledge/logs/*.log").out;
    check("and the daemon never warned about its trampolines", !log.includes("[pty]"), log.split("\n").find((l) => l.includes("[pty]"))?.slice(0, 80));

    // The flags are the fixture's: in a container `pair` refuses to guess the
    // account, address and host keys (pair.ts, containerRefusal).
    const flags = "--user ledge --host 192.0.2.10 --keys /etc/ssh/ssh_host_ed25519_key.pub";
    const paired = run([...macArgv.slice(0, -1), `~/.ledge-server/bin/ledge pair ${flags}`], { quiet: true });
    check("the pair command the script prints works over ssh", paired.code === 0 && paired.out.includes("SHA256:"), (paired.err || "").split("\n")[0]?.slice(0, 80));

    if (update) {
      step(`[${image}] an update to ${NEXT}, with the Mac still connected`);
      const next = inside("curl -fsSL file:///release/next/server.sh | sudo -iu ledge sh");
      check("the newer script installs", next.code === 0 && next.out.includes(`ledge-server ${NEXT} is installed`), next.err.slice(0, 80));
      check("and says the running server stays until it exits", next.out.includes(`A ledge-server ${version} that is already running goes on serving`));
      const versions = asLedge(`ls ${home}/versions`).out.split("\n");
      check("both versions are on disk", versions.includes(version) && versions.includes(NEXT), versions.join(", "));
      check("the launcher names the new one", asLedge(`cat ${home}/bin/ledge`).out.includes(`/versions/${NEXT}/bun`));

      const during = await connect("probe-during", macArgv);
      check("a connection during the update still gets a server", during.hello.build === BUILD_VERSION);
      check("the one already running", daemon()?.pid === first?.pid, `pid ${daemon()?.pid}`);
      during.client.close();
      mac.client.close();

      const start = Date.now();
      while (Date.now() - start < 120_000 && daemon()?.pid === first?.pid) await Bun.sleep(1000);
      check("it exits on its own once nothing is connected", daemon() === null, `after ${Math.round((Date.now() - start) / 1000)}s`);
      const after = await connect("probe-after", macArgv);
      check("and the next connection starts the new version", daemon()?.args === expected(NEXT), daemon()?.args ?? "no daemon");
      after.client.close();
    } else {
      mac.client.close();
    }
  } catch (err) {
    bad(`${image}: the probe threw`, (err as Error).message.slice(0, 300));
  } finally {
    run(["docker", "rm", "-f", name], { quiet: true });
  }
}

async function macMachine(target: NativeTarget) {
  const home = join(SCRATCH, "mac-home");
  mkdirSync(home);
  // What sshd on macOS gives a command (remote.md §11), with a scratch HOME.
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh", LEDGE_NOTES_ROOT: join(home, ".ledge") };
  let pid = "";
  try {
    step(`[${target.platform}-${target.arch}] this Mac, into a scratch HOME`);
    const installed = run(["/bin/sh", "-c", `curl -fsSL 'file://${RELEASE}/server-mac.sh' | sh`], { quiet: true, env });
    check("server.sh installs it", installed.code === 0 && installed.out.includes(`ledge-server ${version} is installed`), (installed.err || "").slice(0, 80));
    check("and adds the PATH line to ~/.zshrc", readFileSync(join(home, ".zshrc"), "utf8").includes('export PATH="$HOME/.ledge-server/bin:$PATH"'));

    const mac = await connect("probe-mac", ["/bin/zsh", "-c", SERVE_COMMAND], env);
    check("zsh -c with sshd's PATH reaches it", mac.hello.build === BUILD_VERSION, `build ${mac.hello.build}`);
    await drive("this Mac", mac);
    pid = readFileSync(join(home, ".ledge", ".server.pid"), "utf8").trim();
    const args = run(["ps", "-o", "command=", "-p", pid], { quiet: true }).out;
    // realpath, because process.execPath resolves /var to /private/var.
    const bun = `${realpathSync(home)}/.ledge-server/versions/${version}/bun `;
    check("the daemon runs on the private Bun", args.startsWith(bun), args.slice(args.indexOf(".ledge-server")));
    const log = run(["sh", "-c", `cat '${home}/.ledge/logs/'*.log`], { quiet: true }).out;
    check("and loaded its trampolines", !log.includes("[pty]"), log.split("\n").find((l) => l.includes("[pty]"))?.slice(0, 80));
    mac.client.close();
  } catch (err) {
    bad("this Mac: the probe threw", (err as Error).message.slice(0, 300));
  } finally {
    if (pid) run(["kill", pid], { quiet: true });
  }
}

try {
  const dockerArch = run(["docker", "info", "--format", "{{.Architecture}}"]).out;
  const linux: NativeTarget = { platform: "linux", arch: /aarch64|arm64/.test(dockerArch) ? "arm64" : "x64" };
  const mac: NativeTarget | null = process.platform === "darwin" ? { platform: "darwin", arch: process.arch === "arm64" ? "arm64" : "x64" } : null;
  if (!existsSync(join(DIST, serverTarball(version)))) {
    console.error(`dist-server/ has no ${serverTarball(version)}. Run \`bun run build:server\` first.`);
    process.exit(2);
  }
  stageRelease(linux, mac);

  step("[alpine:3] a musl machine, refused before anything downloads");
  const alpine = (user: string[]) => run(["docker", "run", "--rm", ...user, "-e", "HOME=/tmp", "-v", `${RELEASE}:/release:ro`, "alpine:3", "sh", "/release/server.sh"], { quiet: true });
  const muslRoot = alpine([]);
  check("root is refused first", muslRoot.err.includes("not as root"), muslRoot.err.slice(0, 70));
  const musl = alpine(["--user", "1000:1000"]);
  check("any other account is told musl cannot run it", musl.code === 1 && musl.err.includes("does not use glibc"), musl.err.slice(0, 70));

  for (const { image, shell, update } of IMAGES) await linuxMachine(image, shell, update);
  if (mac) await macMachine(mac);
} catch (err) {
  bad("the probe threw", (err as Error).message);
} finally {
  await rm(SCRATCH, { recursive: true, force: true });
}

check("the scratch directory is gone", !existsSync(SCRATCH));
console.log(failures === 0 ? "\nAll claims held." : `\n${failures} claim(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
