// This computer's server on Windows: `ledge serve` inside WSL, reached through
// wsl.exe's stdin and stdout. Windows cannot run the server itself (no openpty,
// no fork), so the app dials a Linux one the way it dials a VPS over ssh, with
// a different argv (remote.md §1). The app carries that server and installs it
// with server.sh, so WSL always has the app's own version. It imports no
// Electrobun and no daemon.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnDuplex } from "./transport";
import type { LocalServer } from "./localServer";
import type { Duplex } from "../shared/transport";
import { INSTALL_SCRIPT, scriptVersion } from "./serverRelease";
import { WINDOWS_APP_FILE, type WindowsApp } from "./wslApp";

/** The install script's address, the one a remote server's manual gives. */
export const SERVER_SH_URL = "https://ledge.sh/server.sh";

/** Where server.sh installs the launcher, under the WSL account's home. */
export const WSL_LEDGE = "$HOME/.ledge/.server/bin/ledge";

/** The server this app carries, `bun/wsl/` in a Windows bundle
 * (electrobun.config.ts `copy`, made by `bun run build:wsl`). */
export const WSL_PAYLOAD = join(import.meta.dir, "wsl");

/** The carried server's directory and version. Null for a build without one,
 * which is a dev build. */
export function wslPayload(dir = WSL_PAYLOAD): { dir: string; version: string } | null {
  try {
    const version = scriptVersion(readFileSync(join(dir, INSTALL_SCRIPT), "utf8"));
    return version ? { dir, version } : null;
  } catch {
    return null;
  }
}

/**
 * Prints the installed server's version, from the comment server.sh writes in
 * its launcher. Exits 1 when there is no launcher, and 3 when WSL signs in as
 * root, which server.sh refuses to install for.
 */
export const WSL_VERSION: readonly string[] = [
  "wsl.exe",
  "--exec",
  "sh",
  "-c",
  `[ "$(id -u)" -ne 0 ] || exit 3; f="${WSL_LEDGE}"; [ -f "$f" ] || exit 1; sed -n 's/^# ledge-server version //p' "$f"`,
];

/** server.sh from the carried directory, taking its tarballs from there too. */
export function installArgv(wslDir: string): string[] {
  return ["wsl.exe", "--exec", "sh", `${wslDir}/${INSTALL_SCRIPT}`, "--from", wslDir];
}

/** The command that attaches to the default distro's server, starting its
 * daemon when none is running. `sh -c` expands $HOME inside Linux. */
export const WSL_SERVE: readonly string[] = ["wsl.exe", "--exec", "sh", "-c", `exec "${WSL_LEDGE}" serve`];

const PID_FILE = '"$HOME/.ledge/.server.pid"';

/** Asks the daemon to exit once nothing is running, as daemon.ts
 * `retireDaemon` does on a Mac. */
export const WSL_RETIRE: readonly string[] = ["wsl.exe", "--exec", "sh", "-c", `pid=$(cat ${PID_FILE} 2>/dev/null) && kill -USR1 "$pid"`];

/** Stops the daemon now and waits up to five seconds for it to go, as daemon.ts
 * `stopDaemon` does. Exits 0 once it is gone or when there was none. */
export const WSL_STOP: readonly string[] = [
  "wsl.exe",
  "--exec",
  "sh",
  "-c",
  `pid=$(cat ${PID_FILE} 2>/dev/null) && kill "$pid" 2>/dev/null || exit 0; i=0; while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); [ $i -lt 50 ] || exit 1; sleep 0.1; done`,
];

export interface WslServerOpts {
  argv?: readonly string[];
  /** The version WSL's server was brought to, when this build carries one.
   * A daemon of another build is then retired. Without it, every daemon is kept. */
  build?: string;
  /** wsl.exe's and the server's stderr, as it arrives. */
  onStderr?(text: string): void;
  /** The process seams, faked by the tests. */
  spawn?(argv: readonly string[], onStderr: (text: string) => void): Duplex;
  run?(argv: readonly string[]): Promise<WslRun>;
}

export function wslServer(opts: WslServerOpts = {}): LocalServer {
  const argv = opts.argv ?? WSL_SERVE;
  const spawn = opts.spawn ?? ((cmd, onStderr) => spawnDuplex(cmd, { onStderr }));
  const run = opts.run ?? runWsl;
  const report = opts.onStderr ?? (() => {});
  let reviewed = "";
  return {
    dial: async () => spawn(argv, report),
    // The same review as a Mac's (bun/localServer.ts): a daemon still running
    // the version this launch replaced makes way once it is idle.
    review(peer) {
      if (!opts.build || peer.instance === reviewed) return "kept";
      reviewed = peer.instance;
      if (peer.build === opts.build) return "kept";
      console.warn(`[wsl] WSL's daemon is build ${peer.build} and its server is now ${opts.build}; it restarts when idle`);
      void run(WSL_RETIRE).catch(() => {});
      return "retired";
    },
  };
}

/** Stops WSL's daemon for a build it refused, and says whether it went. */
export async function stopWslDaemon(run: (argv: readonly string[]) => Promise<WslRun> = runWsl): Promise<boolean> {
  const res = await run(WSL_STOP).catch(() => null);
  return res?.code === 0;
}

/** Why Ledge cannot start, for a message box: a headline and what to do. */
export interface WslProblem {
  headline: string;
  detail: string;
}

const NO_WSL: WslProblem = {
  headline: "Ledge needs WSL",
  detail:
    "Ledge keeps your notes and runs your code in WSL, the Windows Subsystem for Linux, which is not installed on this PC. Install it before Ledge can finish installing: open PowerShell as administrator, run wsl --install, and restart Windows. Then open Ledge again.",
};

const NO_DISTRO: WslProblem = {
  headline: "Ledge needs a Linux distribution in WSL",
  detail:
    "WSL is installed but has no Linux distribution, and Ledge keeps your notes and runs your code in one. Install one before Ledge can finish installing: in PowerShell, run wsl --install -d Ubuntu, and create the Linux account it asks for. Then open Ledge again.",
};

const AS_ROOT: WslProblem = {
  headline: "Ledge needs a Linux account in WSL",
  detail:
    "WSL signs in to Linux as root, and Ledge installs its server for an ordinary account. Open your Linux distribution from the Start menu and create the account it asks for, then open Ledge again.",
};

/** The problem wsl.exe's own message names: WSL, or a distribution, missing. */
export function wslMissing(said: string): WslProblem | null {
  // wsl.exe writes its own messages in UTF-16, which reach a UTF-8 decoder
  // with a NUL after every ASCII byte.
  const text = said.replaceAll("\0", "");
  if (/no installed distributions/i.test(text)) return NO_DISTRO;
  if (/not installed|is not recognized|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED/i.test(text)) return NO_WSL;
  return null;
}

/**
 * The sentence for a WSL dial that ended before the server said hello, from
 * what wsl.exe and the shell wrote to stderr. Null when nothing matches, so the
 * caller falls back to the error it has.
 */
export function explainWsl(stderr: string): string | null {
  const missing = wslMissing(stderr);
  if (missing) return missing.detail;
  if (/ledge: (command )?not found|ledge: No such file/.test(stderr.replaceAll("\0", ""))) {
    return "Ledge's server is missing from WSL. Quit Ledge and open it again, which installs it.";
  }
  return null;
}

/** One finished wsl.exe run: its exit code and everything it printed. */
export interface WslRun {
  code: number;
  output: string;
}

/** Runs `argv` to the end. stdout and stderr are read together, NULs dropped. */
export async function runWsl(argv: readonly string[]): Promise<WslRun> {
  const proc = Bun.spawn({ cmd: [...argv], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output: (out + err).replaceAll("\0", "") };
}

export interface EnsureDeps {
  /** The server this app carries (`wslPayload`), or null for a dev build. */
  payload: { dir: string; version: string } | null;
  run?(argv: readonly string[]): Promise<WslRun>;
  /** Says an install has started, while it runs. */
  started(): void;
  /** Reports a problem that leaves no server to dial. */
  fail(problem: WslProblem): Promise<void>;
}

/**
 * Brings WSL's server to the version this app carries before the first window
 * opens: installed when there is none, replaced when it is another version.
 * True when there is a server to dial. False when there is none, and `fail`
 * has been told why: WSL or a distribution is missing, WSL signs in as root,
 * or server.sh failed. A build that carries no server dials whatever WSL has.
 */
export async function ensureWslServer(deps: EnsureDeps): Promise<boolean> {
  const run = deps.run ?? runWsl;
  const found = await run(WSL_VERSION).catch(() => null);
  // No wsl.exe to start at all.
  if (!found) return (await deps.fail(NO_WSL), false);
  const missing = found.code === 0 ? null : wslMissing(found.output);
  if (missing) return (await deps.fail(missing), false);
  if (found.code === 3) return (await deps.fail(AS_ROOT), false);
  if (found.code !== 0 && found.code !== 1) {
    return (await deps.fail(cannotStart(`WSL could not start a shell: ${lastLine(found.output) || `exit ${found.code}`}`)), false);
  }
  const installed = found.code === 0 ? lastLine(found.output) : null;

  const { payload } = deps;
  if (!payload) {
    if (installed !== null) return true;
    return (
      await deps.fail(cannotStart(`This build of Ledge carries no server, and WSL has none installed. In a WSL terminal, run: curl -fsSL ${SERVER_SH_URL} | sh`)),
      false
    );
  }
  if (installed === payload.version) return true;

  // The bundle is on a Windows drive, which WSL mounts under /mnt.
  const dir = await wslFolder(payload.dir, run);
  if (!dir) {
    return (await deps.fail(cannotStart(`WSL cannot reach the folder Ledge is installed in, ${payload.dir}, so Ledge cannot install its server there.`)), false);
  }
  deps.started();
  console.log(`[wsl] installing server ${payload.version} over ${installed ?? "none"}`);
  const install = await run(installArgv(dir)).catch((err) => ({ code: -1, output: String(err) }));
  for (const line of install.output.split("\n")) if (line.trim()) console.log(`[wsl] ${line.trim()}`);
  const after = await run(WSL_VERSION).catch(() => null);
  if (install.code === 0 && after?.code === 0 && lastLine(after.output) === payload.version) return true;
  await deps.fail(cannotStart(`Installing Ledge's server in WSL failed: ${lastLine(install.output) || `exit ${install.code}`}`));
  return false;
}

function cannotStart(detail: string): WslProblem {
  return { headline: "Ledge cannot start", detail };
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop()?.trim() ?? "";
}

/** The WSL account's home as Windows sees it, `\\wsl.localhost\<distro>\home\<user>`. */
export const WSL_HOME: readonly string[] = ["wsl.exe", "--exec", "sh", "-c", 'wslpath -w "$HOME"'];

/** The Windows path of WSL's home, where the folder dialog opens. Null when
 * WSL could not say. */
export async function wslHome(run: (argv: readonly string[]) => Promise<WslRun> = runWsl): Promise<string | null> {
  const home = await run(WSL_HOME).catch(() => null);
  return home?.code === 0 ? lastLine(home.output) || null : null;
}

/**
 * A folder from the Windows dialog, as the path the server in WSL knows it
 * by, from WSL's own `wslpath`: `\\wsl.localhost\Ubuntu\home\dan\notes` is
 * `/home/dan/notes` and `C:\notes` is `/mnt/c/notes`. Null for a folder the
 * default distro cannot reach: another distro's, a network share, a drive WSL
 * has not mounted.
 */
export async function wslFolder(
  windowsPath: string,
  run: (argv: readonly string[]) => Promise<WslRun> = runWsl,
): Promise<string | null> {
  const res = await run(["wsl.exe", "--exec", "wslpath", "-u", windowsPath]).catch(() => null);
  const path = res?.code === 0 ? lastLine(res.output) : "";
  return path.startsWith("/") ? path : null;
}

/**
 * The command that records this app's launcher for `ledge open` in WSL
 * (bun/wslApp.ts). The record crosses as base64 in an argument, which no
 * command line on either side can mangle, and lands through a temp file.
 */
export function recordArgv(app: WindowsApp): string[] {
  const b64 = Buffer.from(JSON.stringify(app)).toString("base64");
  const file = `"$HOME/.ledge/${WINDOWS_APP_FILE}"`;
  return ["wsl.exe", "--exec", "sh", "-c", `mkdir -p "$HOME/.ledge" && printf %s "$1" | base64 -d > ${file}.tmp && mv ${file}.tmp ${file}`, "sh", b64];
}

/** Writes the record. A failure is logged and otherwise ignored: only `ledge
 * open` in WSL needs it. */
export async function recordWindowsApp(app: WindowsApp, run: (argv: readonly string[]) => Promise<WslRun> = runWsl): Promise<void> {
  const res = await run(recordArgv(app)).catch((err) => ({ code: -1, output: String(err) }));
  if (res.code !== 0) console.error(`[wsl] could not record the app for ledge open: ${lastLine(res.output) || `exit ${res.code}`}`);
}
