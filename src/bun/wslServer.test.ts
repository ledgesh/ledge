// The Windows app's dial into WSL (bun/wslServer.ts). The process seam is
// faked, so these run on any host: what they check is the argv, the verdict on
// another build, and the sentences for a dial that never reached the server.
import { describe, expect, test } from "bun:test";
import { ensureWslServer, explainWsl, recordArgv, WSL_CHECK, WSL_HOME, WSL_INSTALL, WSL_SERVE, wslFolder, wslHome, wslServer, type WslRun } from "./wslServer";
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

  // server.sh owns that install, so the app has nothing to replace it with.
  test("keeps a server of another build", () => {
    expect(wslServer().review({ build: "0.0.9", instance: "a" })).toBe("kept");
  });
});

describe("a dial that ended before the server answered", () => {
  test("no launcher: says how to install the server", () => {
    const said = 'sh: 1: exec: /home/dan/.ledge/.server/bin/ledge: not found\n';
    expect(explainWsl(said)).toContain("curl -fsSL https://ledge.sh/server.sh | sh");
  });

  // wsl.exe writes UTF-16, which arrives with a NUL after every ASCII byte.
  test("no distribution, in wsl.exe's UTF-16", () => {
    const said = [..."Windows Subsystem for Linux has no installed distributions."].join("\0") + "\0";
    expect(explainWsl(said)).toStartWith("WSL has no Linux distribution installed.");
  });

  test("no WSL at all", () => {
    expect(explainWsl("'wsl.exe' is not recognized as an internal or external command")).toStartWith("WSL is not installed.");
  });

  test("anything else is left to the caller", () => {
    expect(explainWsl("")).toBeNull();
    expect(explainWsl("[serve] ledge 0.1.2 attached\n")).toBeNull();
  });
});

describe("before the first window", () => {
  // `answers` is what each run returns, in order: the check, then the install
  // and the check after it.
  function deps(answers: WslRun[], ask = true) {
    const log: string[] = [];
    return {
      log,
      deps: {
        run: async (argv: readonly string[]) => {
          log.push(argv === WSL_CHECK ? "check" : argv === WSL_INSTALL ? "install" : argv.join(" "));
          return answers.shift() ?? { code: 0, output: "" };
        },
        ask: async () => (log.push("ask"), ask),
        started: () => void log.push("started"),
        fail: async (m: string) => void log.push(`fail: ${m}`),
      },
    };
  }

  test("a server already there: nothing asked, nothing installed", async () => {
    const { log, deps: d } = deps([{ code: 0, output: "" }]);
    expect(await ensureWslServer(d)).toBe(true);
    expect(log).toEqual(["check"]);
  });

  test("no server: asks, installs, checks again", async () => {
    const { log, deps: d } = deps([{ code: 1, output: "" }, { code: 0, output: "installed" }, { code: 0, output: "" }]);
    expect(await ensureWslServer(d)).toBe(true);
    expect(log).toEqual(["check", "ask", "started", "install", "check"]);
  });

  test("a decline installs nothing and reports nothing", async () => {
    const { log, deps: d } = deps([{ code: 1, output: "" }], false);
    expect(await ensureWslServer(d)).toBe(false);
    expect(log).toEqual(["check", "ask"]);
  });

  // `curl | sh` exits with sh's status, and sh reading nothing exits 0, so
  // only the second check can tell a failed download from a good install.
  test("an install that exits 0 but left no launcher is a failure, with curl's last line", async () => {
    const said = "curl: (6) Could not resolve host: ledge.sh";
    const { log, deps: d } = deps([{ code: 1, output: "" }, { code: 0, output: said }, { code: 1, output: "" }]);
    expect(await ensureWslServer(d)).toBe(false);
    expect(log.at(-1)).toBe(`fail: Installing Ledge's server in WSL failed: ${said}`);
  });

  test("WSL with no distribution fails before asking", async () => {
    const { log, deps: d } = deps([{ code: -1, output: "Windows Subsystem for Linux has no installed distributions." }]);
    expect(await ensureWslServer(d)).toBe(false);
    expect(log).toEqual(["check", expect.stringMatching(/^fail: WSL has no Linux distribution installed/)]);
  });

  test("no wsl.exe at all fails before asking", async () => {
    const { log, deps: d } = deps([]);
    d.run = async () => {
      log.push("check");
      throw new Error("Executable not found in $PATH: \"wsl.exe\"");
    };
    expect(await ensureWslServer(d)).toBe(false);
    expect(log).toEqual(["check", 'fail: WSL could not start a shell: Error: Executable not found in $PATH: "wsl.exe"']);
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
