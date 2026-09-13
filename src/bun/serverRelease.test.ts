// The server release and the install script it carries (remote.md §11). The
// script runs under sh and dash on a fake machine: stub
// `uname`, `id`, `getconf`, `sysctl`, `launchctl` and `curl` come first on PATH,
// and the "release" is tarballs in a scratch directory holding a fake Bun.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVE_COMMAND } from "../shared/connections";
import { NATIVE_TARGETS } from "./npmPackage";
import {
  BUN_BUILDS,
  BUN_VERSION,
  releaseDownload,
  releaseName,
  renderInstallScript,
  sumsText,
  targetKey,
} from "./serverRelease";

const ROOT = resolve(import.meta.dir, "..", "..");
const TEMPLATE = readFileSync(join(ROOT, "release", "server.sh"), "utf8");
const SHELLS = ["/bin/sh", "/bin/dash"].filter((s) => existsSync(s));
const DOWNLOAD = "https://example.invalid/releases/download/v0";

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
  download?: string;
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

/** A scratch machine: a home and a release directory to fill. */
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

/** A tarball for `key` in the release directory, returning its SHA-256. */
function tarball(w: World, version: string, key: string, bun = FAKE_BUN): string {
  const name = `ledge-server-${version}-${key}`;
  const stage = join(w.base, "stage", name);
  mkdirSync(join(stage, "bin"), { recursive: true });
  mkdirSync(join(stage, "lib"), { recursive: true });
  writeFileSync(join(stage, "bun"), bun + "\n");
  chmodSync(join(stage, "bun"), 0o755);
  writeFileSync(join(stage, "bin", "ledge-server.js"), "// entry\n");
  writeFileSync(join(stage, "lib", "serve.js"), "// bundle\n");
  const file = join(w.release, `${name}.tar.gz`);
  const tar = Bun.spawnSync(["tar", "-czf", file, "-C", join(w.base, "stage"), name], { stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  rmSync(join(w.base, "stage"), { recursive: true, force: true });
  return sha256(readFileSync(file));
}

function script(version: string, sums: Record<string, string>): string {
  return renderInstallScript(TEMPLATE, { version, download: DOWNLOAD, sums });
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
  if (machine.download) env["LEDGE_SERVER_DOWNLOAD"] = machine.download;
  const file = join(w.base, "server.sh");
  writeFileSync(file, text);
  const argv = piped ? [shell, "-s", "--", ...args] : [shell, file, ...args];
  const done = Bun.spawnSync(argv, { env, stdin: piped ? Buffer.from(text) : "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

const installed = (w: World) => join(w.home, ".ledge-server");
const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("the release's pins", () => {
  test("the Bun a release ships is the one CI runs the suite on", () => {
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci.match(/bun-version:\s*([\d.]+)/)?.[1]).toBe(BUN_VERSION);
  });

  test("every target the package serves has a pinned Bun build, and nothing else does", () => {
    expect(Object.keys(BUN_BUILDS).sort()).toEqual(NATIVE_TARGETS.map(targetKey).sort());
    for (const build of Object.values(BUN_BUILDS)) expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("names and sums are spelled the way the script and sha256sum read them", () => {
    expect(releaseName("0.1.0", { platform: "linux", arch: "arm64" })).toBe("ledge-server-0.1.0-linux-arm64");
    expect(releaseDownload("0.1.0")).toBe("https://github.com/ledgesh/ledge/releases/download/v0.1.0");
    expect(sumsText([{ name: "a.tar.gz", sha256: "ab" }])).toBe("ab  a.tar.gz\n");
  });
});

describe("rendering server.sh", () => {
  const sums = Object.fromEntries(NATIVE_TARGETS.map((t) => [targetKey(t), "0".repeat(64)]));

  test("fills every placeholder, and the result parses in every shell here", () => {
    const text = script("0.1.0", sums);
    expect(text).not.toMatch(/@[A-Z0-9_]+@/);
    expect(text).toContain("version='0.1.0'");
    expect(text).toContain(`LEDGE_SERVER_DOWNLOAD:-${DOWNLOAD}}`);
    for (const shell of SHELLS) {
      expect(Bun.spawnSync([shell, "-n"], { stdin: Buffer.from(text) }).exitCode).toBe(0);
    }
  });

  test("refuses values that would break the script or a file name", () => {
    expect(() => script("0.1.0'; rm -rf ~", sums)).toThrow();
    expect(() => script("0.1.0", { ...sums, "linux-x64": "not-a-sum" })).toThrow();
    expect(() => renderInstallScript(`${TEMPLATE}\n@NOT_A_THING@`, { version: "0.1.0", download: DOWNLOAD, sums })).toThrow();
  });
});

describe("server.sh", () => {
  test.each(SHELLS)("%s installs into versions/<version> and writes a launcher that runs the Bun it came with", (shell) => {
    const w = world();
    const sum = tarball(w, "0.1.0", "linux-arm64");
    const run = install(w, script("0.1.0", { "linux-arm64": sum }), LINUX, [], shell, true);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const version = join(installed(w), "versions", "0.1.0");
    expect(run.out).toContain(`ledge-server 0.1.0 is installed in ${installed(w)}.`);
    expect(run.out).toContain("~/.ledge-server/bin/ledge-server pair");
    expect(w.downloads()).toEqual([`${DOWNLOAD}/ledge-server-0.1.0-linux-arm64.tar.gz`]);

    const launched = Bun.spawnSync([join(installed(w), "bin", "ledge-server"), "pair"], { stdout: "pipe" });
    expect(launched.stdout.toString()).toBe(`bun ${version}/bun|${version}/bin/ledge-server.js pair`);
    expect(listing(installed(w))).toEqual(["bin", "versions"]);
  });

  // The whole point of the location: what the apps run over ssh finds it with
  // nothing else on PATH (remote.md §4a).
  test("the command the apps run over ssh finds the installed server", () => {
    const w = world();
    const sum = tarball(w, "0.1.0", "linux-arm64");
    expect(install(w, script("0.1.0", { "linux-arm64": sum }), LINUX).code).toBe(0);
    const served = Bun.spawnSync(["/bin/sh", "-c", SERVE_COMMAND], { env: { HOME: w.home, PATH: "/usr/bin:/bin" }, stdout: "pipe" });
    const version = join(installed(w), "versions", "0.1.0");
    expect(served.stdout.toString()).toBe(`bun ${version}/bun|${version}/bin/ledge-server.js serve`);
  });

  test("a home directory with a space and a quote in its name still gets a launcher that runs", () => {
    const w = world("it's a home");
    const sum = tarball(w, "0.1.0", "linux-arm64");
    expect(install(w, script("0.1.0", { "linux-arm64": sum }), LINUX).code).toBe(0);
    const launched = Bun.spawnSync([join(installed(w), "bin", "ledge-server"), "serve"], { stdout: "pipe" });
    expect(launched.stdout.toString()).toEndWith("/versions/0.1.0/bin/ledge-server.js serve");
  });

  test.each([
    ["Darwin", "arm64", "0", "darwin-arm64"],
    ["Darwin", "x86_64", "0", "darwin-x64"],
    ["Darwin", "x86_64", "1", "darwin-arm64"],
    ["Linux", "aarch64", "0", "linux-arm64"],
    ["Linux", "x86_64", "0", "linux-x64"],
    ["Linux", "amd64", "0", "linux-x64"],
  ])("%s %s (translated=%s) downloads the %s tarball", (kernel, machine, translated, key) => {
    const w = world();
    const run = install(w, script("0.1.0", { [key]: "0".repeat(64) }), { kernel, machine, translated, glibc: "2.36" }, ["--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`from ${DOWNLOAD}/ledge-server-0.1.0-${key}.tar.gz`);
  });

  test("LEDGE_SERVER_DOWNLOAD replaces where it downloads from", () => {
    const w = world();
    const run = install(w, script("0.1.0", { "linux-arm64": "0".repeat(64) }), { ...LINUX, download: "file:///mirror" }, ["--dry-run"]);
    expect(run.out).toContain("from file:///mirror/ledge-server-0.1.0-linux-arm64.tar.gz");
  });

  test("--dry-run downloads nothing and writes nothing", () => {
    const w = world();
    const run = install(w, script("0.1.0", { "linux-arm64": "0".repeat(64) }), LINUX, ["--dry-run"]);
    expect(run.code).toBe(0);
    expect(w.downloads()).toEqual([]);
    expect(listing(w.home)).toEqual([]);
  });

  describe("refusals, each of which leaves the home directory untouched", () => {
    const refused = (w: World, run: { code: number; err: string }, said: string) => {
      expect(run.code).toBe(1);
      expect(run.err).toContain(said);
      expect(listing(join(installed(w), "versions"))).toEqual([]);
      expect(existsSync(join(installed(w), "bin", "ledge-server"))).toBe(false);
      expect(listing(installed(w)).filter((f) => f.startsWith(".download."))).toEqual([]);
    };

    test("root, since the server belongs in the home of the account Ledge signs in to", () => {
      const w = world();
      refused(w, install(w, script("0.1.0", { "linux-arm64": "0".repeat(64) }), { ...LINUX, uid: "0" }), "not as root");
      expect(w.downloads()).toEqual([]);
    });

    test("musl, and a glibc older than 2.29", () => {
      const w = world();
      const text = script("0.1.0", { "linux-arm64": "0".repeat(64) });
      refused(w, install(w, text, { kernel: "Linux", machine: "aarch64" }), "does not use glibc");
      refused(w, install(w, text, { ...LINUX, glibc: "2.28" }), "glibc 2.28 is too old");
      expect(install(w, text, { ...LINUX, glibc: "2.29" }, ["--dry-run"]).code).toBe(0);
    });

    test("an operating system or processor no release is built for", () => {
      const w = world();
      const text = script("0.1.0", { "linux-arm64": "0".repeat(64) });
      refused(w, install(w, text, { kernel: "FreeBSD", machine: "amd64" }), "FreeBSD is not supported");
      refused(w, install(w, text, { ...LINUX, machine: "riscv64" }), "riscv64 processors are not supported");
    });

    test("a target this release has no tarball for", () => {
      const w = world();
      refused(w, install(w, script("0.1.0", { "darwin-arm64": "0".repeat(64) }), LINUX), "has no build for linux-arm64");
    });

    test("a download that does not match its checksum", () => {
      const w = world();
      tarball(w, "0.1.0", "linux-arm64");
      refused(w, install(w, script("0.1.0", { "linux-arm64": "1".repeat(64) }), LINUX), "does not match its checksum");
    });

    test("a download that fails", () => {
      const w = world();
      refused(w, install(w, script("0.1.0", { "linux-arm64": "1".repeat(64) }), LINUX), "could not download");
    });

    test("a Bun that does not run on this machine, with what it said", () => {
      const w = world();
      const broken = "#!/bin/sh\necho \"bun: /lib/libc.so.6: version 'GLIBC_2.29' not found\" >&2\nexit 1";
      const sum = tarball(w, "0.1.0", "linux-arm64", broken);
      refused(w, install(w, script("0.1.0", { "linux-arm64": sum }), LINUX), "does not run on this machine: bun: /lib/libc.so.6");
    });

    test("an option it does not have", () => {
      const w = world();
      refused(w, install(w, script("0.1.0", {}), LINUX, ["--prefix=/opt"]), "unknown option --prefix=/opt");
    });
  });

  describe("running it again", () => {
    test("with the same version downloads nothing", () => {
      const w = world();
      const text = script("0.1.0", { "linux-arm64": tarball(w, "0.1.0", "linux-arm64") });
      expect(install(w, text, LINUX).code).toBe(0);
      const again = install(w, text, LINUX);
      expect(again.code).toBe(0);
      expect(again.out).toContain("ledge-server 0.1.0 is already in");
      expect(w.downloads()).toHaveLength(1);
    });

    test("repairs an install whose files went missing", () => {
      const w = world();
      const text = script("0.1.0", { "linux-arm64": tarball(w, "0.1.0", "linux-arm64") });
      expect(install(w, text, LINUX).code).toBe(0);
      rmSync(join(installed(w), "versions", "0.1.0", "lib"), { recursive: true });
      expect(install(w, text, LINUX).code).toBe(0);
      expect(w.downloads()).toHaveLength(2);
      expect(existsSync(join(installed(w), "versions", "0.1.0", "lib", "serve.js"))).toBe(true);
    });

    test("with a newer version switches the launcher, keeps the previous version and removes older ones", () => {
      const w = world();
      const versions = ["0.1.0", "0.2.0", "0.3.0"];
      const texts = versions.map((v) => script(v, { "linux-arm64": tarball(w, v, "linux-arm64") }));
      expect(install(w, texts[0]!, LINUX).code).toBe(0);
      const second = install(w, texts[1]!, LINUX);
      expect(second.out).toContain("A ledge-server 0.1.0 that is already running goes on serving");
      expect(listing(join(installed(w), "versions"))).toEqual(["0.1.0", "0.2.0"]);
      expect(install(w, texts[2]!, LINUX).code).toBe(0);
      expect(listing(join(installed(w), "versions"))).toEqual(["0.2.0", "0.3.0"]);
      const launched = Bun.spawnSync([join(installed(w), "bin", "ledge-server")], { stdout: "pipe" });
      expect(launched.stdout.toString()).toContain("/versions/0.3.0/bun|");
    });
  });

  describe("the PATH line for new terminals", () => {
    const LINE = 'export PATH="$HOME/.ledge-server/bin:$PATH"';

    test.each([
      ["/bin/zsh", LINUX, ".zshrc"],
      ["/bin/bash", LINUX, ".bashrc"],
      ["/bin/bash", { kernel: "Darwin", machine: "arm64" }, ".bash_profile"],
      ["/bin/sh", LINUX, ".profile"],
    ] as const)("a %s login shell on %o gets it in %s, once", (shell, machine, file) => {
      const w = world();
      const key = machine.kernel === "Darwin" ? "darwin-arm64" : "linux-arm64";
      const t = script("0.1.0", { [key]: tarball(w, "0.1.0", key) });
      const first = install(w, t, { ...machine, shell });
      expect(first.code).toBe(0);
      expect(first.out).toContain(`a PATH line was added to ${join(w.home, file)}`);
      expect(install(w, t, { ...machine, shell }).code).toBe(0);
      const lines = readFileSync(join(w.home, file), "utf8").split("\n");
      expect(lines.filter((l) => l === LINE)).toHaveLength(1);
    });

    test("--no-modify-path, or a PATH that already has the directory, leaves startup files alone", () => {
      const w = world();
      const t = script("0.1.0", { "linux-arm64": tarball(w, "0.1.0", "linux-arm64") });
      expect(install(w, t, { ...LINUX, shell: "/bin/zsh" }, ["--no-modify-path"]).code).toBe(0);
      expect(install(w, t, { ...LINUX, shell: "/bin/zsh", path: `${w.stubs}:${installed(w)}/bin:/usr/bin:/bin` }).code).toBe(0);
      expect(existsSync(join(w.home, ".zshrc"))).toBe(false);
    });
  });

  describe("warnings after an install", () => {
    test("a csh login shell, which cannot run what ssh is asked to run", () => {
      const w = world();
      const t = script("0.1.0", { "linux-arm64": tarball(w, "0.1.0", "linux-arm64") });
      expect(install(w, t, { ...LINUX, shell: "/bin/tcsh" }).out).toContain("login shell is tcsh, which cannot start ledge-server over ssh");
    });

    test("a Mac with Remote Login off", () => {
      const w = world();
      const sum = tarball(w, "0.1.0", "darwin-arm64");
      const t = script("0.1.0", { "darwin-arm64": sum });
      const mac: Machine = { kernel: "Darwin", machine: "arm64" };
      expect(install(w, t, { ...mac, remoteLogin: "disabled" }).out).toContain("Remote Login is off");
      expect(install(w, t, { ...mac, remoteLogin: "enabled" }).out).not.toContain("Remote Login");
    });
  });
});
