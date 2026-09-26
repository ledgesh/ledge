// The Windows app's dial into WSL (bun/wslServer.ts). The process seam is
// faked, so these run on any host: what they check is the argv, the verdict on
// another build, the install of the server the app carries, and the sentences
// for a WSL that cannot serve.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureWslServer,
  explainWsl,
  installArgv,
  recordArgv,
  stopWslDaemon,
  WSL_HOME,
  WSL_RETIRE,
  WSL_SERVE,
  WSL_STOP,
  WSL_VERSION,
  wslFolder,
  wslHome,
  wslMissing,
  wslPayload,
  wslServer,
  type WslProblem,
  type WslRun,
} from "./wslServer";
import type { Duplex } from "../shared/transport";

const duplex: Duplex = { write() {}, close() {} };

describe("the dial", () => {
  test("runs the launcher server.sh installs, through sh so $HOME expands inside Linux", async () => {
    const spawned: (readonly string[])[] = [];
    const server = wslServer({ spawn: (argv) => (spawned.push(argv), duplex) });
    expect(await server.dial()).toBe(duplex);
    expect(spawned).toEqual([WSL_SERVE]);
    expect(WSL_SERVE).toEqual(["wsl.exe", "--exec", "sh", "-c", 'exec "$HOME/.ledge/.server/bin/ledge" serve']);
  });

  test("passes stderr to the caller", async () => {
    const heard: string[] = [];
    const server = wslServer({ spawn: (_argv, onStderr) => (onStderr("[serve] attached"), duplex), onStderr: (t) => heard.push(t) });
    await server.dial();
    expect(heard).toEqual(["[serve] attached"]);
  });
});

describe("a daemon of another build", () => {
  const ran = () => {
    const argvs: (readonly string[])[] = [];
    return { argvs, run: async (argv: readonly string[]) => (argvs.push(argv), { code: 0, output: "" }) };
  };

  test("is retired once, when WSL's server was brought to this app's version", () => {
    const { argvs, run } = ran();
    const server = wslServer({ build: "0.1.3", run });
    expect(server.review({ build: "0.1.2", instance: "a" })).toBe("retired");
    expect(server.review({ build: "0.1.2", instance: "a" })).toBe("kept");
    expect(server.review({ build: "0.1.3", instance: "b" })).toBe("kept");
    expect(argvs).toEqual([WSL_RETIRE]);
    expect(WSL_RETIRE.at(-1)).toBe('pid=$(cat "$HOME/.ledge/.server.pid" 2>/dev/null) && kill -USR1 "$pid"');
  });

  // A dev build carries no server, so a restart would bring back the same one.
  test("is kept by a build that carries no server", () => {
    const { argvs, run } = ran();
    expect(wslServer({ run }).review({ build: "0.0.9", instance: "a" })).toBe("kept");
    expect(argvs).toEqual([]);
  });

  test("that refused this build is stopped, and the answer says whether it went", async () => {
    const { argvs, run } = ran();
    expect(await stopWslDaemon(run)).toBe(true);
    expect(argvs).toEqual([WSL_STOP]);
    expect(await stopWslDaemon(async () => ({ code: 1, output: "" }))).toBe(false);
    expect(await stopWslDaemon(async () => Promise.reject(new Error("spawn failed")))).toBe(false);
  });
});

describe("a WSL that cannot serve", () => {
  test("no launcher: says reopening installs it", () => {
    const said = "sh: 1: exec: /home/dan/.ledge/.server/bin/ledge: not found\n";
    expect(explainWsl(said)).toBe("Ledge's server is missing from WSL. Quit Ledge and open it again, which installs it.");
  });

  // wsl.exe writes UTF-16, which arrives with a NUL after every ASCII byte.
  test("no distribution, in wsl.exe's UTF-16", () => {
    const said = [..."Windows Subsystem for Linux has no installed distributions."].join("\0") + "\0";
    expect(wslMissing(said)?.headline).toBe("Ledge needs a Linux distribution in WSL");
    expect(explainWsl(said)).toContain("wsl --install -d Ubuntu");
  });

  test("no WSL at all", () => {
    const problem = wslMissing("'wsl.exe' is not recognized as an internal or external command");
    expect(problem?.headline).toBe("Ledge needs WSL");
    expect(problem?.detail).toContain("Install it before Ledge can finish installing");
    expect(wslMissing("Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.")).toBe(problem);
  });

  test("anything else is left to the caller", () => {
    expect(explainWsl("")).toBeNull();
    expect(explainWsl("[serve] ledge 0.1.2 attached\n")).toBeNull();
  });
});

describe("the server the app carries", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  test("is read from its server.sh; a build without one carries none", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledge-wsl-payload-"));
    dirs.push(dir);
    expect(wslPayload(dir)).toBeNull();
    writeFileSync(join(dir, "server.sh"), "#!/bin/sh\nset -eu\n\nversion='0.1.3'\nregistry=x\n");
    expect(wslPayload(dir)).toEqual({ dir, version: "0.1.3" });
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "empty", "server.sh"), "#!/bin/sh\n");
    expect(wslPayload(join(dir, "empty"))).toBeNull();
  });

  test("is installed with its own server.sh, taking the tarballs beside it", () => {
    expect(installArgv("/mnt/c/Program Files/Ledge/bun/wsl")).toEqual([
      "wsl.exe",
      "--exec",
      "sh",
      "/mnt/c/Program Files/Ledge/bun/wsl/server.sh",
      "--from",
      "/mnt/c/Program Files/Ledge/bun/wsl",
    ]);
  });
});

describe("before the first window", () => {
  const PAYLOAD = { dir: "C:\\Users\\dan\\AppData\\Local\\sh.ledge.app\\stable\\app\\Resources\\app\\bun\\wsl", version: "0.1.3" };
  const WSL_DIR = "/mnt/c/Users/dan/AppData/Local/sh.ledge.app/stable/app/Resources/app/bun/wsl";

  // `answers` is what each run returns, in order.
  function deps(answers: (WslRun | Error)[], payload: typeof PAYLOAD | null = PAYLOAD) {
    const log: string[] = [];
    const failed: WslProblem[] = [];
    return {
      log,
      failed,
      deps: {
        payload,
        run: async (argv: readonly string[]) => {
          log.push(
            argv === WSL_VERSION ? "version" : argv[2] === "wslpath" ? "wslpath" : argv.includes("--from") ? `install ${argv.at(-1)}` : argv.join(" "),
          );
          const next = answers.shift() ?? { code: 0, output: "" };
          if (next instanceof Error) throw next;
          return next;
        },
        started: () => void log.push("started"),
        fail: async (p: WslProblem) => void (log.push(`fail: ${p.headline}`), failed.push(p)),
      },
    };
  }

  test("WSL already at this version: nothing installed", async () => {
    const { log, deps: d } = deps([{ code: 0, output: "0.1.3\n" }]);
    expect(await ensureWslServer(d)).toBe(true);
    expect(log).toEqual(["version"]);
  });

  test("no server yet: installs the carried one from WSL's path to it, then checks", async () => {
    const { log, deps: d } = deps([
      { code: 1, output: "" },
      { code: 0, output: `${WSL_DIR}\n` },
      { code: 0, output: "ledge-server 0.1.3 is installed" },
      { code: 0, output: "0.1.3\n" },
    ]);
    expect(await ensureWslServer(d)).toBe(true);
    expect(log).toEqual(["version", "wslpath", "started", `install ${WSL_DIR}`, "version"]);
  });

  // An update brings the app first. Older or newer, WSL's server follows it.
  test("another version: replaced by the carried one", async () => {
    for (const other of ["0.1.2", "0.2.0", ""]) {
      const { log, deps: d } = deps([{ code: 0, output: `${other}\n` }, { code: 0, output: WSL_DIR }, { code: 0, output: "" }, { code: 0, output: "0.1.3" }]);
      expect(await ensureWslServer(d)).toBe(true);
      expect(log).toEqual(["version", "wslpath", "started", `install ${WSL_DIR}`, "version"]);
    }
  });

  test("an install that leaves another version is a failure, with server.sh's last line", async () => {
    const said = "Copying...\nledge-server: glibc 2.28 is too old. ledge-server needs glibc 2.29 or later.";
    const { failed, deps: d } = deps([{ code: 1, output: "" }, { code: 0, output: WSL_DIR }, { code: 1, output: said }, { code: 1, output: "" }]);
    expect(await ensureWslServer(d)).toBe(false);
    expect(failed).toEqual([
      { headline: "Ledge cannot start", detail: "Installing Ledge's server in WSL failed: ledge-server: glibc 2.28 is too old. ledge-server needs glibc 2.29 or later." },
    ]);
  });

  test("a bundle WSL cannot reach installs nothing", async () => {
    const { log, failed, deps: d } = deps([{ code: 1, output: "" }, { code: 1, output: "wslpath: C:\\...: Invalid argument" }]);
    expect(await ensureWslServer(d)).toBe(false);
    expect(log).toEqual(["version", "wslpath", "fail: Ledge cannot start"]);
    expect(failed[0]!.detail).toStartWith("WSL cannot reach the folder Ledge is installed in");
  });

  test("no wsl.exe at all: says to install WSL before anything else", async () => {
    const { log, failed, deps: d } = deps([new Error('Executable not found in $PATH: "wsl.exe"')]);
    expect(await ensureWslServer(d)).toBe(false);
    expect(log).toEqual(["version", "fail: Ledge needs WSL"]);
    expect(failed[0]!.detail).toContain("run wsl --install, and restart Windows");
  });

  // Exit 1 is also what the check says for no launcher, so wsl.exe's own
  // words are read first.
  test("WSL not installed, or with no distribution, whatever wsl.exe exits with", async () => {
    for (const [code, output, headline] of [
      [1, "Windows Subsystem for Linux is not installed.", "Ledge needs WSL"],
      [-1, "Windows Subsystem for Linux has no installed distributions.", "Ledge needs a Linux distribution in WSL"],
    ] as const) {
      const { log, deps: d } = deps([{ code, output }]);
      expect(await ensureWslServer(d)).toBe(false);
      expect(log).toEqual(["version", `fail: ${headline}`]);
    }
  });

  test("WSL signing in as root, which server.sh will not install for", async () => {
    const { log, deps: d } = deps([{ code: 3, output: "" }]);
    expect(await ensureWslServer(d)).toBe(false);
    expect(log).toEqual(["version", "fail: Ledge needs a Linux account in WSL"]);
  });

  test("a build that carries no server dials whatever WSL has, and says how to install one when there is none", async () => {
    const some = deps([{ code: 0, output: "0.0.9" }], null);
    expect(await ensureWslServer(some.deps)).toBe(true);
    expect(some.log).toEqual(["version"]);
    const none = deps([{ code: 1, output: "" }], null);
    expect(await ensureWslServer(none.deps)).toBe(false);
    expect(none.failed[0]!.detail).toContain("curl -fsSL https://ledge.sh/server.sh | sh");
  });

  test("the version check refuses root, then reads the launcher's version comment", () => {
    expect(WSL_VERSION.slice(0, 4)).toEqual(["wsl.exe", "--exec", "sh", "-c"]);
    expect(WSL_VERSION[4]).toBe(
      `[ "$(id -u)" -ne 0 ] || exit 3; f="$HOME/.ledge/.server/bin/ledge"; [ -f "$f" ] || exit 1; sed -n 's/^# ledge-server version //p' "$f"`,
    );
  });
});

describe("the folder dialog", () => {
  const answering = (runs: Record<string, WslRun>) => {
    const asked: (readonly string[])[] = [];
    const run = async (argv: readonly string[]) => (asked.push(argv), runs[argv.at(-1)!] ?? { code: 1, output: `wslpath: ${argv.at(-1)}` });
    return { asked, run };
  };

  test("opens in WSL's home, as Windows spells it", async () => {
    const { asked, run } = answering({ 'wslpath -w "$HOME"': { code: 0, output: "\\\\wsl.localhost\\Ubuntu\\home\\dan\n" } });
    expect(await wslHome(run)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\dan");
    expect(asked).toEqual([WSL_HOME]);
  });

  test("falls back when WSL cannot say where home is", async () => {
    expect(await wslHome(async () => ({ code: 1, output: "" }))).toBeNull();
    expect(await wslHome(async () => Promise.reject(new Error("spawn failed")))).toBeNull();
  });

  test("hands the server the path wslpath gives for the pick", async () => {
    const picked = "C:\\Users\\dan\\My Notes";
    const { asked, run } = answering({ [picked]: { code: 0, output: "/mnt/c/Users/dan/My Notes\n" } });
    expect(await wslFolder(picked, run)).toBe("/mnt/c/Users/dan/My Notes");
    expect(asked).toEqual([["wsl.exe", "--exec", "wslpath", "-u", picked]]);
  });

  test("answers null for a folder WSL cannot reach", async () => {
    const { run } = answering({});
    expect(await wslFolder("\\\\wsl.localhost\\Debian\\home", run)).toBeNull();
    expect(await wslFolder("\\\\server\\share", async () => ({ code: 0, output: "" }))).toBeNull();
  });
});

describe("the record for ledge open", () => {
  test("carries the launcher as base64, which no command line quotes differently", () => {
    const app = { launcher: "C:\\Users\\dan\\AppData\\Local\\sh.ledge.app\\stable\\app\\bin\\launcher.exe", pid: 4242 };
    const argv = recordArgv(app);
    expect(argv.slice(0, 4)).toEqual(["wsl.exe", "--exec", "sh", "-c"]);
    expect(argv[4]).toContain('> "$HOME/.ledge/.windows-app.json".tmp && mv');
    expect(argv[5]).toBe("sh");
    expect(argv[6]).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(JSON.parse(Buffer.from(argv[6]!, "base64").toString())).toEqual(app);
  });

});
