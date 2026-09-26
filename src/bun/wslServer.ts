// This computer's server on Windows: `ledge serve` inside WSL, reached through
// wsl.exe's stdin and stdout. Windows cannot run the server itself (no openpty,
// no fork), so the app dials a Linux one the way it dials a VPS over ssh, with
// a different argv (remote.md §1). It imports no Electrobun and no daemon.
import { spawnDuplex } from "./transport";
import type { LocalServer } from "./localServer";
import type { Duplex } from "../shared/transport";

/** The install script's address, the one a remote server's manual gives. */
export const SERVER_SH_URL = "https://ledge.sh/server.sh";

/** Where server.sh installs the launcher, under the WSL account's home. */
export const WSL_LEDGE = "$HOME/.ledge/.server/bin/ledge";

/** Exits 0 when the launcher is there, 1 when it is not. Any other exit, or
 * wsl.exe failing to start a shell at all, is WSL's own problem. */
export const WSL_CHECK: readonly string[] = ["wsl.exe", "--exec", "sh", "-c", `test -x "${WSL_LEDGE}"`];

/** server.sh, fetched with curl or, on a distro without it, wget. */
export const WSL_INSTALL: readonly string[] = [
  "wsl.exe",
  "--exec",
  "sh",
  "-c",
  `if command -v curl >/dev/null; then curl -fsSL ${SERVER_SH_URL}; else wget -qO- ${SERVER_SH_URL}; fi | sh`,
];

/** The command that attaches to the default distro's server, starting its
 * daemon when none is running. `sh -c` expands $HOME inside Linux. */
export const WSL_SERVE: readonly string[] = ["wsl.exe", "--exec", "sh", "-c", `exec "${WSL_LEDGE}" serve`];

export interface WslServerOpts {
  argv?: readonly string[];
  /** wsl.exe's and the server's stderr, as it arrives. */
  onStderr?(text: string): void;
  /** The process seam, faked by the tests. */
  spawn?(argv: readonly string[], onStderr: (text: string) => void): Duplex;
}

export function wslServer(opts: WslServerOpts = {}): LocalServer {
  const argv = opts.argv ?? WSL_SERVE;
  const spawn = opts.spawn ?? ((cmd, onStderr) => spawnDuplex(cmd, { onStderr }));
  const report = opts.onStderr ?? (() => {});
  return {
    dial: async () => spawn(argv, report),
    // The server in WSL is installed and updated by server.sh, not by this
    // app, so a daemon of another build is kept rather than retired.
    review: () => "kept",
  };
}

/**
 * The sentence for a WSL dial that ended before the server said hello, from
 * what wsl.exe and the shell wrote to stderr. Null when nothing matches, so the
 * caller falls back to the error it has.
 */
export function explainWsl(stderr: string): string | null {
  // wsl.exe writes its own messages in UTF-16, which reach a UTF-8 decoder
  // with a NUL after every ASCII byte.
  const text = stderr.replaceAll("\0", "");
  if (/no installed distributions/i.test(text)) {
    return "WSL has no Linux distribution installed. Run wsl --install in PowerShell, then install Ledge's server inside it.";
  }
  if (/not installed|is not recognized|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED/i.test(text)) {
    return "WSL is not installed. Run wsl --install in PowerShell, restart, then install Ledge's server inside it.";
  }
  if (/ledge: (command )?not found|ledge: No such file/.test(text)) {
    return "Ledge's server is not installed in WSL. In a WSL terminal, run: curl -fsSL https://ledge.sh/server.sh | sh";
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
  run?(argv: readonly string[]): Promise<WslRun>;
  /** Asks before installing. True means install. */
  ask(): Promise<boolean>;
  /** Says the install has started, while it runs. */
  started(): void;
  /** Reports a failure that leaves no server to dial. */
  fail(message: string): Promise<void>;
}

/**
 * Makes sure WSL has a server to dial before the first window opens. True when
 * there is one, installed now or already. False when there is none: WSL is
 * missing, the person declined, or server.sh failed. `fail` has been told why,
 * except for a decline.
 */
export async function ensureWslServer(deps: EnsureDeps): Promise<boolean> {
  const run = deps.run ?? runWsl;
  const check = await run(WSL_CHECK).catch((err) => ({ code: -1, output: String(err) }));
  if (check.code === 0) return true;
  if (check.code !== 1) {
    await deps.fail(explainWsl(check.output) ?? `WSL could not start a shell: ${lastLine(check.output) || `exit ${check.code}`}`);
    return false;
  }
  if (!(await deps.ask())) return false;
  deps.started();
  console.log("[wsl] installing the server with server.sh");
  const install = await run(WSL_INSTALL).catch((err) => ({ code: -1, output: String(err) }));
  for (const line of install.output.split("\n")) if (line.trim()) console.log(`[wsl] ${line.trim()}`);
  if (install.code === 0 && (await run(WSL_CHECK)).code === 0) return true;
  await deps.fail(`Installing Ledge's server in WSL failed: ${lastLine(install.output) || `exit ${install.code}`}`);
  return false;
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop()?.trim() ?? "";
}
