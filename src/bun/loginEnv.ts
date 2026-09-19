// Reads the environment a login shell would have, once per server process, as
// the base layer every note shell spawns with (architecture.md §6a). A Mac app
// opened from the Dock inherits launchd's PATH, and note shells run `-i`
// without `-l`, so nothing reads ~/.zprofile, where Homebrew puts its PATH.
// The resolving shell runs `-l` and not `-i`: the note shell sources the rc
// files itself, and an rc that execs tmux or fish would never return here.
import { homedir } from "node:os";

/** How long the login shell gets to print its env before boot gives up on it. */
export const LOGIN_ENV_TIMEOUT_MS = 5_000;

/** Set for the resolving shell, so a profile can tell it apart from a real login. */
export const RESOLVING_VAR = "LEDGE_RESOLVING_ENVIRONMENT";

// Facts about the resolving shell itself rather than about the account. The
// note shell sets its own.
const DROPPED = new Set(["PWD", "OLDPWD", "SHLVL", "_", RESOLVING_VAR]);

/** The line the login shell runs: the env NUL-separated between two markers,
 * so whatever a profile prints to stdout is ignored. */
export function envCommand(nonce: string): string {
  return `printf '%s' '${nonce}<'; /usr/bin/env -0; printf '%s' '>${nonce}'`;
}

/**
 * Parses what `envCommand(nonce)` printed. Returns null when the markers are
 * missing, which is what a shell that failed, or has no `env -0`, prints.
 */
export function parseEnvOutput(output: string, nonce: string): Record<string, string> | null {
  const start = output.indexOf(`${nonce}<`);
  if (start < 0) return null;
  const from = start + nonce.length + 1;
  const end = output.lastIndexOf(`>${nonce}`);
  if (end < from) return null;
  const env: Record<string, string> = {};
  for (const entry of output.slice(from, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * The login env as a spawn's base layer: the shell's own bookkeeping dropped,
 * and PATH with repeats removed. A server started from a terminal already has
 * the profile's PATH, and the login shell prepends it a second time.
 */
export function cleanLoginEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!DROPPED.has(key)) out[key] = value;
  }
  if (out["PATH"] !== undefined) out["PATH"] = dedupePath(out["PATH"]);
  return out;
}

/** PATH with each directory kept at its first position. */
export function dedupePath(path: string): string {
  const seen = new Set<string>();
  return path
    .split(":")
    .filter((dir) => {
      if (dir === "" || seen.has(dir)) return false;
      seen.add(dir);
      return true;
    })
    .join(":");
}

export interface LoginEnvOpts {
  timeoutMs?: number;
  cwd?: string;
  warn?: (msg: string) => void;
  /** Defaults to whether LEDGE_SKIP_LOGIN_ENV is set. */
  skip?: boolean;
}

/**
 * Runs `shellPath -l -c` and returns the env it reports, or `base` when the
 * shell fails, prints no env, or outlives the timeout. `base` is also what the
 * shell starts from, so a login shell only adds to what the server already has.
 * LEDGE_SKIP_LOGIN_ENV skips the shell entirely: the test preload sets it, so
 * no test runs the profile of whoever is running the tests.
 */
export async function resolveLoginEnv(
  shellPath: string,
  base: Record<string, string | undefined>,
  opts: LoginEnvOpts = {},
): Promise<Record<string, string>> {
  const fallback = definedOnly(base);
  if (opts.skip ?? Boolean(process.env["LEDGE_SKIP_LOGIN_ENV"])) return fallback;
  const warn = opts.warn ?? ((msg: string) => console.warn("[loginEnv]", msg));
  const timeoutMs = opts.timeoutMs ?? LOGIN_ENV_TIMEOUT_MS;
  const nonce = `ledge-env-${crypto.randomUUID()}`;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [shellPath, "-l", "-c", envCommand(nonce)],
      env: { ...fallback, [RESOLVING_VAR]: "1" },
      cwd: opts.cwd ?? homedir(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (err) {
    warn(`could not start ${shellPath} to read the login environment (${err}); using the app's own`);
    return fallback;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const output = await Promise.race([new Response(proc.stdout as ReadableStream).text(), timedOut]);
  clearTimeout(timer);
  if (output === null) {
    proc.kill("SIGKILL");
    warn(`${shellPath} -l took over ${timeoutMs} ms to start; using the app's own environment`);
    return fallback;
  }
  const env = parseEnvOutput(output, nonce);
  if (!env) {
    warn(`${shellPath} -l printed no environment; using the app's own`);
    return fallback;
  }
  return cleanLoginEnv(env);
}

function definedOnly(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
