// The server release and the install script it carries (remote.md §11). The
// script runs under sh and dash on a fake machine: stub
// `uname`, `id`, `getconf`, `sysctl`, `launchctl` and `curl` come first on PATH,
// and the "registry" is npm-shaped tarballs in a scratch directory, one of them
// holding a fake Bun.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SERVE_COMMAND } from "../shared/connections";
import { NATIVE_TARGETS, nativePath } from "./npmPackage";
import {
  BUN_PACKAGES,
  BUN_VERSION,
  renderInstallScript,
  serverTarball,
  sumsText,
  tarballPath,
  targetKey,
} from "./serverRelease";

const ROOT = resolve(import.meta.dir, "..", "..");
const TEMPLATE = readFileSync(join(ROOT, "release", "server.sh"), "utf8");
const SHELLS = ["/bin/sh", "/bin/dash"].filter((s) => existsSync(s));
const REGISTRY = "https://registry.example.invalid";
const ZERO = "0".repeat(64);
const KEYS = NATIVE_TARGETS.map(targetKey);

const STUBS: Record<string, string> = {
  uname: 'case "$1" in -s) echo "$FAKE_KERNEL" ;; -m) echo "$FAKE_MACHINE" ;; esac',
  id: 'echo "${FAKE_UID:-501}"',
  getconf: 'if [ -n "${FAKE_GLIBC:-}" ]; then echo "glibc $FAKE_GLIBC"; else echo "getconf: no such configuration parameter" >&2; exit 1; fi',
  sysctl: 'echo "${FAKE_TRANSLATED:-0}"',
  launchctl: 'printf \'\\t"com.openssh.sshd" => %s\\n\' "${FAKE_REMOTE_LOGIN:-enabled}"',
  curl: [
    'out=""; url=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done',
    'printf "%s\\n" "$url" >>"$FAKE_LOG"',
    'file="$FAKE_RELEASE/${url##*/}"',
    'if [ ! -f "$file" ]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi',
    'cp "$file" "$out"',
  ].join("\n"),
};

const FAKE_BUN = [
  "#!/bin/sh",
  'if [ "$1" = --version ]; then echo 1.3.14; exit 0; fi',
  "printf 'bun %s|%s' \"$0\" \"$*\"",
].join("\n");

interface Machine {
  kernel: string;
  machine: string;
  glibc?: string;
  translated?: string;
  uid?: string;
  shell?: string;
  remoteLogin?: string;
  path?: string;
  registry?: string;
}

const LINUX: Machine = { kernel: "Linux", machine: "aarch64", glibc: "2.36" };

let scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// One directory of stubs for the whole file. macOS checks an executable the
// first time it runs, which costs about 200ms per new file.
const STUB_DIR = mkdtempSync(join(tmpdir(), "ledge-release-stubs-"));
for (const [name, body] of Object.entries(STUBS)) {
  writeFileSync(join(STUB_DIR, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(STUB_DIR, name), 0o755);
}
afterAll(() => rmSync(STUB_DIR, { recursive: true, force: true }));

/** A scratch machine: a home and a registry directory to fill. */
function world(homeName = "home") {
  const base = mkdtempSync(join(tmpdir(), "ledge-release-"));
  scratch.push(base);
  const home = join(base, homeName);
  const stubs = STUB_DIR;
  const release = join(base, "release");
  for (const dir of [home, release]) mkdirSync(dir, { recursive: true });
  const log = join(base, "downloads.log");
  writeFileSync(log, "");
  return { base, home, stubs, release, log, downloads: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

type World = ReturnType<typeof world>;

/** An npm-shaped tarball, everything under `package/`, returning its SHA-256. */
function npmTarball(w: World, file: string, files: Record<string, string>): string {
  const stage = join(w.base, "stage");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, "package", path)), { recursive: true });
    writeFileSync(join(stage, "package", path), body);
  }
  const out = join(w.release, file);
  const tar = Bun.spawnSync(["tar", "-czf", out, "-C", stage, "package"], { stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  rmSync(stage, { recursive: true, force: true });
  return sha256(readFileSync(out));
}

interface ReleaseOptions {
  /** The machine's target, whose Bun tarball is built. */
  key?: string;
  /** The targets the server tarball has trampolines for. */
  targets?: string[];
  bun?: string;
  serverSum?: string;
  bunSum?: string;
}

/**
 * A release in the world's registry and the script for it. A world's Bun
 * tarball is built once, so scripts rendered earlier keep matching it.
 */
function release(w: World, version: string, opts: ReleaseOptions = {}): string {
  const key = opts.key ?? "linux-arm64";
  const native = Object.fromEntries(
    NATIVE_TARGETS.filter((t) => (opts.targets ?? [key]).includes(targetKey(t))).map((t) => [nativePath(t), "trampolines"]),
  );
  const serverSum = npmTarball(w, serverTarball(version), { "bin/ledge.js": "// entry\n", "lib/serve.js": "// bundle\n", ...native });
  const name = BUN_PACKAGES[key]!.name;
  const bunFile = tarballPath(name, BUN_VERSION).split("/").pop()!;
  const bunSum = existsSync(join(w.release, bunFile))
    ? sha256(readFileSync(join(w.release, bunFile)))
    : npmTarball(w, bunFile, { "bin/bun": (opts.bun ?? FAKE_BUN) + "\n" });
  return script(version, { serverSum: opts.serverSum ?? serverSum, key, bunSum: opts.bunSum ?? bunSum });
}

/** The script alone, with the real Bun pins except for `key`, whose checksum is `bunSum`. */
function script(version: string, sums: { serverSum?: string; key?: string; bunSum?: string } = {}): string {
  const packages = { ...BUN_PACKAGES };
  if (sums.key) packages[sums.key] = { name: BUN_PACKAGES[sums.key]!.name, sha256: sums.bunSum ?? ZERO };
  return renderInstallScript(TEMPLATE, { version, registry: REGISTRY, serverSum: sums.serverSum ?? ZERO, bun: { version: BUN_VERSION, packages } });
}

/**
 * Runs the script as `sh script` by default. `piped` feeds it on stdin the way
 * `curl | sh` does, which costs a shell reading a pipe a byte at a time, so
 * only the install test in each shell pays it.
 */
function install(w: World, text: string, machine: Machine, args: string[] = [], shell = "/bin/sh", piped = false) {
  const env: Record<string, string> = {
    HOME: w.home,
    PATH: machine.path ?? `${w.stubs}:/usr/bin:/bin`,
    SHELL: machine.shell ?? "/bin/sh",
    FAKE_KERNEL: machine.kernel,
    FAKE_MACHINE: machine.machine,
    FAKE_LOG: w.log,
    FAKE_RELEASE: w.release,
  };
  if (machine.glibc) env["FAKE_GLIBC"] = machine.glibc;
  if (machine.translated) env["FAKE_TRANSLATED"] = machine.translated;
  if (machine.uid) env["FAKE_UID"] = machine.uid;
  if (machine.remoteLogin) env["FAKE_REMOTE_LOGIN"] = machine.remoteLogin;
  if (machine.registry) env["LEDGE_SERVER_REGISTRY"] = machine.registry;
  const file = join(w.base, "server.sh");
  writeFileSync(file, text);
  const argv = piped ? [shell, "-s", "--", ...args] : [shell, file, ...args];
  const done = Bun.spawnSync(argv, { env, stdin: piped ? Buffer.from(text) : "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

const installed = (w: World) => join(w.home, ".ledge", ".server");
const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const serverUrl = (version: string) => `${REGISTRY}/${tarballPath("ledge-server", version)}`;
const bunUrl = (key: string, registry = REGISTRY) => `${registry}/${tarballPath(BUN_PACKAGES[key]!.name, BUN_VERSION)}`;

describe("the release's pins", () => {
  test("the Bun a release installs is the one CI runs the suite on", () => {
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci.match(/bun-version:\s*([\d.]+)/)?.[1]).toBe(BUN_VERSION);
  });

  test("every target the package serves has Oven's Bun package pinned, x64 as the baseline build", () => {
    expect(Object.keys(BUN_PACKAGES).sort()).toEqual([...KEYS].sort());
    for (const [key, pkg] of Object.entries(BUN_PACKAGES)) {
      const [platform, arch] = key.split("-");
      expect(pkg.name).toBe(`@oven/bun-${platform}-${arch === "x64" ? "x64-baseline" : "aarch64"}`);
      expect(pkg.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("tarball paths and sums are spelled the way the registry and sha256sum spell them", () => {
    expect(tarballPath("@oven/bun-linux-aarch64", "1.3.14")).toBe("@oven/bun-linux-aarch64/-/bun-linux-aarch64-1.3.14.tgz");
    expect(serverTarball("0.1.0")).toBe("ledge-server-0.1.0.tgz");
    expect(sumsText([{ name: "a.tgz", sha256: "ab" }])).toBe("ab  a.tgz\n");
  });
});

describe("rendering server.sh", () => {
  test("fills every placeholder with the pinned Bun, and the result parses in every shell here", () => {
    const text = renderInstallScript(TEMPLATE, { version: "0.1.0", registry: REGISTRY, serverSum: ZERO });
    expect(text).not.toMatch(/@[A-Z0-9_]+@/);
    expect(text).toContain("version='0.1.0'");
    expect(text).toContain(`LEDGE_SERVER_REGISTRY:-${REGISTRY}}`);
    expect(text).toContain(`bun_version='${BUN_VERSION}'`);
    expect(text).toContain(`bun_sum_linux_x64='${BUN_PACKAGES["linux-x64"]!.sha256}'`);
    for (const shell of SHELLS) {
      expect(Bun.spawnSync([shell, "-n"], { stdin: Buffer.from(text) }).exitCode).toBe(0);
    }
  });

  test("refuses values that would break the script or a file name", () => {
    const ok = { version: "0.1.0", registry: REGISTRY, serverSum: ZERO };
    expect(() => renderInstallScript(TEMPLATE, { ...ok, version: "0.1.0'; rm -rf ~" })).toThrow();
    expect(() => renderInstallScript(TEMPLATE, { ...ok, serverSum: "not-a-sum" })).toThrow();
    expect(() => renderInstallScript(TEMPLATE, { ...ok, registry: "https://it's.invalid" })).toThrow();
    const { "linux-x64": _, ...three } = BUN_PACKAGES;
    expect(() => renderInstallScript(TEMPLATE, { ...ok, bun: { version: BUN_VERSION, packages: three } })).toThrow();
    expect(() => renderInstallScript(`${TEMPLATE}\n@NOT_A_THING@`, ok)).toThrow();
  });
});

describe("server.sh", () => {
  test.each(SHELLS)("%s installs the package and its Bun into versions/<version>, with a ledge launcher that runs that Bun", (shell) => {
    const w = world();
    const run = install(w, release(w, "0.1.0"), LINUX, [], shell, true);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const version = join(installed(w), "versions", "0.1.0");
    expect(run.out).toContain(`ledge-server 0.1.0 is installed in ${installed(w)}.`);
    expect(run.out).toContain("~/.ledge/.server/bin/ledge pair");
    expect(w.downloads()).toEqual([serverUrl("0.1.0"), bunUrl("linux-arm64")]);

    const launched = Bun.spawnSync([join(installed(w), "bin", "ledge"), "pair"], { stdout: "pipe" });
    expect(launched.stdout.toString()).toBe(`bun ${version}/bun|${version}/bin/ledge.js pair`);
    // The notes CLI is the same launcher: the caller's first word is the verb.
    const cli = Bun.spawnSync([join(installed(w), "bin", "ledge"), "ls", "--all"], { stdout: "pipe" });
    expect(cli.stdout.toString()).toBe(`bun ${version}/bun|${version}/bin/ledge.js ls --all`);
    expect(listing(join(installed(w), "bin"))).toEqual(["ledge"]);
    expect(listing(installed(w))).toEqual(["bin", "versions"]);
    expect(listing(version)).toEqual(["bin", "bun", "lib"]);
  });

  // The whole point of the location: what the apps run over ssh finds it with
  // nothing else on PATH (remote.md §4a).
  test("the command the apps run over ssh finds the installed server", () => {
    const w = world();
    expect(install(w, release(w, "0.1.0"), LINUX).code).toBe(0);
    const served = Bun.spawnSync(["/bin/sh", "-c", SERVE_COMMAND], { env: { HOME: w.home, PATH: "/usr/bin:/bin" }, stdout: "pipe" });
    const version = join(installed(w), "versions", "0.1.0");
    expect(served.stdout.toString()).toBe(`bun ${version}/bun|${version}/bin/ledge.js serve`);
  });

  test("a home directory with a space and a quote in its name still gets a launcher that runs", () => {
    const w = world("it's a home");
    expect(install(w, release(w, "0.1.0"), LINUX).code).toBe(0);
    const launched = Bun.spawnSync([join(installed(w), "bin", "ledge"), "serve"], { stdout: "pipe" });
    expect(launched.stdout.toString()).toEndWith("/versions/0.1.0/bin/ledge.js serve");
  });

  test.each([
    ["Darwin", "arm64", "0", "darwin-arm64"],
    ["Darwin", "x86_64", "0", "darwin-x64"],
    ["Darwin", "x86_64", "1", "darwin-arm64"],
    ["Linux", "aarch64", "0", "linux-arm64"],
    ["Linux", "x86_64", "0", "linux-x64"],
    ["Linux", "amd64", "0", "linux-x64"],
  ])("%s %s (translated=%s) takes the %s Bun", (kernel, machine, translated, key) => {
    const w = world();
    const run = install(w, script("0.1.0"), { kernel, machine, translated, glibc: "2.36" }, ["--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`from ${serverUrl("0.1.0")}`);
    expect(run.out).toContain(`with Bun ${BUN_VERSION} from ${bunUrl(key)}`);
  });

  test("LEDGE_SERVER_REGISTRY replaces where both come from", () => {
    const w = world();
    const run = install(w, script("0.1.0"), { ...LINUX, registry: "https://npm.example.com/api/npm" }, ["--dry-run"]);
    expect(run.out).toContain("from https://npm.example.com/api/npm/ledge-server/-/ledge-server-0.1.0.tgz");
    expect(run.out).toContain(`from ${bunUrl("linux-arm64", "https://npm.example.com/api/npm")}`);
  });

  test("--dry-run downloads nothing and writes nothing", () => {
    const w = world();
    const run = install(w, script("0.1.0"), LINUX, ["--dry-run"]);
    expect(run.code).toBe(0);
    expect(w.downloads()).toEqual([]);
    expect(listing(w.home)).toEqual([]);
  });

  describe("refusals, each of which leaves the home directory untouched", () => {
    const refused = (w: World, run: { code: number; err: string }, said: string) => {
      expect(run.code).toBe(1);
      expect(run.err).toContain(said);
      expect(listing(join(installed(w), "versions"))).toEqual([]);
      expect(existsSync(join(installed(w), "bin", "ledge"))).toBe(false);
      expect(listing(installed(w)).filter((f) => f.startsWith(".download."))).toEqual([]);
    };

    test("root, since the server belongs in the home of the account Ledge signs in to", () => {
      const w = world();
      refused(w, install(w, script("0.1.0"), { ...LINUX, uid: "0" }), "not as root");
      expect(w.downloads()).toEqual([]);
    });

    test("musl, and a glibc older than 2.29", () => {
      const w = world();
      const text = script("0.1.0");
      refused(w, install(w, text, { kernel: "Linux", machine: "aarch64" }), "does not use glibc");
      refused(w, install(w, text, { ...LINUX, glibc: "2.28" }), "glibc 2.28 is too old");
      expect(install(w, text, { ...LINUX, glibc: "2.29" }, ["--dry-run"]).code).toBe(0);
    });

    test("an operating system or processor no release is built for", () => {
      const w = world();
      const text = script("0.1.0");
      refused(w, install(w, text, { kernel: "FreeBSD", machine: "amd64" }), "FreeBSD is not supported");
      refused(w, install(w, text, { ...LINUX, machine: "riscv64" }), "riscv64 processors are not supported");
    });

    test("a package with no trampolines for this machine, before Bun is downloaded", () => {
      const w = world();
      refused(w, install(w, release(w, "0.1.0", { targets: ["darwin-arm64"] }), LINUX), "ledge-server 0.1.0 has no build for linux-arm64");
      expect(w.downloads()).toEqual([serverUrl("0.1.0")]);
    });

    test("a server tarball or a Bun tarball that does not match its checksum", () => {
      const w = world();
      refused(w, install(w, release(w, "0.1.0", { serverSum: "1".repeat(64) }), LINUX), "ledge-server-0.1.0.tgz does not match its checksum");
      refused(w, install(w, release(w, "0.1.0", { bunSum: "1".repeat(64) }), LINUX), `bun-linux-aarch64-${BUN_VERSION}.tgz does not match its checksum`);
    });

    test("a download that fails", () => {
      const w = world();
      refused(w, install(w, script("0.1.0", { serverSum: "1".repeat(64) }), LINUX), `could not download ${serverUrl("0.1.0")}`);
    });

    test("a Bun that does not run on this machine, with what it said", () => {
      const w = world();
      const broken = "#!/bin/sh\necho \"bun: /lib/libc.so.6: version 'GLIBC_2.29' not found\" >&2\nexit 1";
      refused(w, install(w, release(w, "0.1.0", { bun: broken }), LINUX), `Bun ${BUN_VERSION} does not run on this machine: bun: /lib/libc.so.6`);
    });

    test("an option it does not have", () => {
      const w = world();
      refused(w, install(w, script("0.1.0"), LINUX, ["--prefix=/opt"]), "unknown option --prefix=/opt");
    });
  });

  describe("running it again", () => {
    test("with the same version downloads nothing", () => {
      const w = world();
      const text = release(w, "0.1.0");
      expect(install(w, text, LINUX).code).toBe(0);
      const again = install(w, text, LINUX);
      expect(again.code).toBe(0);
      expect(again.out).toContain("ledge-server 0.1.0 is already in");
      expect(w.downloads()).toHaveLength(2);
    });

    test("repairs an install whose files went missing", () => {
      const w = world();
      const text = release(w, "0.1.0");
      expect(install(w, text, LINUX).code).toBe(0);
      rmSync(join(installed(w), "versions", "0.1.0", "lib"), { recursive: true });
      expect(install(w, text, LINUX).code).toBe(0);
      expect(w.downloads()).toHaveLength(4);
      expect(existsSync(join(installed(w), "versions", "0.1.0", "lib", "serve.js"))).toBe(true);
    });

    test("with a newer version switches the launcher, keeps the previous version and removes older ones", () => {
      const w = world();
      const texts = ["0.1.0", "0.2.0", "0.3.0"].map((v) => release(w, v));
      expect(install(w, texts[0]!, LINUX).code).toBe(0);
      const second = install(w, texts[1]!, LINUX);
      expect(second.out).toContain("A ledge-server 0.1.0 that is already running goes on serving");
      expect(listing(join(installed(w), "versions"))).toEqual(["0.1.0", "0.2.0"]);
      expect(install(w, texts[2]!, LINUX).code).toBe(0);
      expect(listing(join(installed(w), "versions"))).toEqual(["0.2.0", "0.3.0"]);
      const launched = Bun.spawnSync([join(installed(w), "bin", "ledge")], { stdout: "pipe" });
      expect(launched.stdout.toString()).toContain("/versions/0.3.0/bun|");
    });
  });

  describe("the PATH line for new terminals", () => {
    const LINE = 'export PATH="$HOME/.ledge/.server/bin:$PATH"';

    test.each([
      ["/bin/zsh", LINUX, ".zshrc"],
      ["/bin/bash", LINUX, ".bashrc"],
      ["/bin/bash", { kernel: "Darwin", machine: "arm64" }, ".bash_profile"],
      ["/bin/sh", LINUX, ".profile"],
    ] as const)("a %s login shell on %o gets it in %s, once", (shell, machine, file) => {
      const w = world();
      const t = release(w, "0.1.0", { key: machine.kernel === "Darwin" ? "darwin-arm64" : "linux-arm64" });
      const first = install(w, t, { ...machine, shell });
      expect(first.code).toBe(0);
      expect(first.out).toContain(`a PATH line was added to ${join(w.home, file)}`);
      expect(install(w, t, { ...machine, shell }).code).toBe(0);
      const lines = readFileSync(join(w.home, file), "utf8").split("\n");
      expect(lines.filter((l) => l === LINE)).toHaveLength(1);
    });

    test("--no-modify-path, or a PATH that already has the directory, leaves startup files alone", () => {
      const w = world();
      const t = release(w, "0.1.0");
      expect(install(w, t, { ...LINUX, shell: "/bin/zsh" }, ["--no-modify-path"]).code).toBe(0);
      expect(install(w, t, { ...LINUX, shell: "/bin/zsh", path: `${w.stubs}:${installed(w)}/bin:/usr/bin:/bin` }).code).toBe(0);
      expect(existsSync(join(w.home, ".zshrc"))).toBe(false);
    });
  });

  describe("warnings after an install", () => {
    test("a csh login shell, which cannot run what ssh is asked to run", () => {
      const w = world();
      expect(install(w, release(w, "0.1.0"), { ...LINUX, shell: "/bin/tcsh" }).out).toContain("login shell is tcsh, which cannot start ledge over ssh");
    });

    test("a Mac with Remote Login off", () => {
      const w = world();
      const t = release(w, "0.1.0", { key: "darwin-arm64" });
      const mac: Machine = { kernel: "Darwin", machine: "arm64" };
      expect(install(w, t, { ...mac, remoteLogin: "disabled" }).out).toContain("Remote Login is off");
      expect(install(w, t, { ...mac, remoteLogin: "enabled" }).out).not.toContain("Remote Login");
    });
  });
});
