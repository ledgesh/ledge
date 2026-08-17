// Turns a session's NoteParams (frontmatter, via sessionConfigure) into the
// cwd and env its shells actually spawn with.
//
// Resolution order is the precedence contract: process.env (scrubbed of
// host-terminal identity, below) < envFile < profile < inline env, with TERM
// pinned back to the base afterwards — a note that exports TERM would not get
// a different terminal, it would get a broken one (xterm.js is the terminal,
// whatever the note claims). cwd resolves first because a relative envFile
// resolves against it.
//
// Every failure degrades and warns, never throws: a missing profile or a
// deleted cwd is a note problem, and the shell must still spawn — a dead Run
// button diagnoses nothing, a shell in $HOME with a warning in the log does.
//
// The filesystem is injected (`SpawnDeps`) so the whole policy is
// unit-testable without touching disk, same move as InlinePool's injected
// spawn; index.ts passes the real fs.
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isEnvName, isProfileName, type NoteParams } from "../shared/frontmatter";
import { parseDotenv } from "../shared/dotenv";

// Deliberately OUTSIDE the notes root: ~/.ledge is the folder people sync and
// back up, and profile files hold secrets. Layout, not crypto, is what keeps
// a synced notes folder from carrying credentials.
//
// Overridable for the same reason NOTES_ROOT is (bun/notes.ts): a test or a
// live probe must never read — or seed — the real profiles. Nothing in the
// app sets it.
export const PROFILES_DIR =
  process.env["LEDGE_PROFILES_DIR"] ?? join(homedir(), ".config", "ledge", "profiles");

// Env vars by which terminal apps announce "your shell runs inside me". Every
// one of them is FALSE inside a Ledge PTY: the app inherited them from
// whatever terminal launched it (`bun run dev` in a cmux pane, say), and
// passing them through makes note shells masquerade as panes of that
// terminal. Not cosmetic: cmux ships a `claude` PATH shim that sees
// CMUX_SURFACE_ID and injects session-tracking hooks, which then fail ("Hook
// cancelled") at the end of a session cmux never owned — every prompt block
// ran with that error appended. Same stance as the TERM pin: xterm.js is the
// terminal here, whatever the environment claims. Scrubbed from the BASE
// layer only, so a note that genuinely wants one (driving the outer cmux over
// its socket, say) can put it back through env:/profile.
const HOST_TERMINAL_PREFIXES = ["CMUX_", "GHOSTTY_", "ITERM_", "WEZTERM_", "KITTY_", "ALACRITTY_"];
const HOST_TERMINAL_VARS = new Set(["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "STY"]);

function scrubHostTerminal(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (HOST_TERMINAL_VARS.has(key) || HOST_TERMINAL_PREFIXES.some((p) => key.startsWith(p))) delete env[key];
  }
}

export interface SpawnDeps {
  // null for unreadable/missing — the distinction does not matter here, both
  // mean "this file contributes nothing".
  readFile: (path: string) => string | null;
  isDir: (path: string) => boolean;
  warn: (msg: string) => void;
}

export interface ResolvedSpawn {
  cwd: string;
  env: Record<string, string>;
}

/**
 * The cwd and env for one session's next shell. `params` is what the view
 * last sent over sessionConfigure, or undefined for a note that never sent
 * any — which must resolve to exactly what shells got before params existed:
 * the base env, in $HOME.
 */
export function resolveSpawn(
  params: NoteParams | undefined,
  baseEnv: Record<string, string>,
  deps: SpawnDeps,
  home: string = homedir(),
  profilesDir: string = PROFILES_DIR,
): ResolvedSpawn {
  const cwd = resolveCwd(params?.cwd ?? null, home, deps);
  const env = { ...baseEnv };
  scrubHostTerminal(env);

  if (params?.envFile) {
    // Relative to the note's cwd, so `envFile: ./.env` composes with
    // `cwd: ~/Projects/x` the way a shell user expects.
    mergeDotenv(env, resolve(cwd, expandTilde(params.envFile, home)), `envFile "${params.envFile}"`, deps);
  }
  if (params?.profile) {
    // Re-validated here, not just in the parser: the parser's check is a typo
    // message for the honest path, this one is the guard on the RPC path —
    // profile names arrive from the least-trusted end and become a filename.
    if (!isProfileName(params.profile)) {
      deps.warn(`profile "${params.profile}" is not a valid profile name; ignoring it`);
    } else {
      mergeDotenv(env, join(profilesDir, `${params.profile}.env`), `profile "${params.profile}"`, deps);
    }
  }
  if (params?.env) {
    for (const [key, value] of Object.entries(params.env)) {
      // Same guard as the profile name and for the same reason: the honest
      // path was already validated by the parser; this is the RPC path.
      if (isEnvName(key) && typeof value === "string") env[key] = value;
      else deps.warn(`ignoring unusable env entry "${key}"`);
    }
  }

  // Pinned last, whatever any layer said (see the header).
  if (baseEnv["TERM"]) env["TERM"] = baseEnv["TERM"];
  return { cwd, env };
}

// --- which shell binary ------------------------------------------------------

/**
 * The shells whose block output Ledge can slice.
 *
 * Not a taste. `markerInit` (bun/markers.ts) installs its OSC 133 end-marker
 * hook as `precmd_functions` under zsh and as `PROMPT_COMMAND` under anything
 * else, and PROMPT_COMMAND is bash's. A shell with neither — dash, which IS
 * `/bin/sh` on Debian, or fish, whose syntax the init line is not even valid
 * in — runs commands perfectly well and never ends a block: every inline run
 * begins, none finishes, and the panel shows no output and no exit code. So
 * the set of shells that work is exactly two, and one outside it has to be a
 * warning rather than a silent default.
 */
export const SUPPORTED_SHELLS = ["zsh", "bash"] as const;

// Tried in order when the login shell is not one of them. zsh first is not a
// preference between the two: /bin/zsh is always present on macOS and rarely
// on Linux, so one fixed order picks the platform's own shell on both without
// this having to ask which platform it is on.
const SHELL_FALLBACKS = [
  "/bin/zsh",
  "/bin/bash",
  "/usr/bin/zsh",
  "/usr/bin/bash",
  "/usr/local/bin/zsh",
  "/usr/local/bin/bash",
] as const;

/** Whether a path names a shell whose block markers Ledge implements. */
export function isSupportedShell(path: string): boolean {
  return (SUPPORTED_SHELLS as readonly string[]).includes(basename(path));
}

/**
 * The shell to spawn on a machine nobody has configured: this account's own
 * login shell when Ledge supports it, else the first supported one installed.
 *
 * The login shell first because `shell.args` is `-i`, so the shell sources the
 * user's rc files. Spawning zsh on a box whose owner lives in `.bashrc` hands
 * them a prompt with none of their PATH, aliases or functions — running, but
 * not theirs. Following $SHELL is what makes a block behave like the terminal
 * they would have got by logging in, which on a server is the whole promise.
 *
 * null when nothing supported is installed: a refusal for the caller to report,
 * never a guess to spawn. Pure, so the ladder is testable without a filesystem;
 * `defaultShellPath` is the one-line wrapper that supplies the real probe.
 */
export function resolveShellPath(
  loginShell: string | undefined,
  isExecutable: (path: string) => boolean,
): string | null {
  if (loginShell && isAbsolute(loginShell) && isSupportedShell(loginShell) && isExecutable(loginShell)) {
    return loginShell;
  }
  return SHELL_FALLBACKS.find(isExecutable) ?? null;
}

/**
 * Why this shell cannot be spawned at all, or null if it can.
 *
 * It gets its own check because the failure it prevents is invisible. The C
 * trampoline (`dist-native/ledge_pty.c`) forks and THEN execs, so a missing
 * binary is the child's error: `fork` succeeds, pty.ts sees a valid pid and
 * reports a healthy spawn, and the only thing the master fd ever carries is
 * the tty echoing the input back. Refusing before the fork is what turns that
 * into a sentence somebody can act on.
 */
export function shellRefusal(path: string, isExecutable: (path: string) => boolean): string | null {
  if (!path) return `no shell is configured: set "shell": { "path": ... } in settings.jsonc`;
  if (!isAbsolute(path)) return `the configured shell (${path}) is not an absolute path`;
  if (!isExecutable(path)) return `the configured shell (${path}) does not exist, or is not executable`;
  return null;
}

/**
 * What is wrong with a shell that will still spawn, or null.
 *
 * Separate from the refusal above because the damage is partial: an unsupported
 * shell gives a working terminal drawer and broken inline runs, and refusing to
 * spawn it would take the half that works away from someone who chose it.
 */
export function shellCaveat(path: string): string | null {
  if (isSupportedShell(path)) return null;
  return (
    `${path} is not ${SUPPORTED_SHELLS.join(" or ")}: the terminal will work, ` +
    `but inline runs cannot report their output or exit codes`
  );
}

/** Executable by this process. The real probe behind the two pure checks. */
export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `resolveShellPath` against this machine and this account. */
export function defaultShellPath(): string | null {
  return resolveShellPath(process.env["SHELL"], isExecutableFile);
}

/**
 * The argv a local shell actually spawns with: `settings.shell.args`, plus
 * `-o interactive_comments` when that shell is zsh.
 *
 * Ledge adds a flag the user did not write because without it a ```sh block
 * means two different things depending on which chord ran it. An inline run
 * sources the body as a file (bun/runner.ts), where `#` starts a comment; the
 * drawer pastes the same body into the line editor, and zsh leaves
 * interactive_comments OFF, so `# step one` is a command named `#` and the
 * block opens with "command not found". bash already enables the same option
 * for interactive shells, which is why the surprise is zsh-shaped. One fence,
 * one meaning, on both chords.
 *
 * An argv flag rather than a `setopt` line written into the pty: the drawer
 * shows every byte its shell receives, so an injected command would print
 * above the first prompt and sit in the user's history forever after.
 *
 * zsh only, by binary name: `-o interactive_comments` is a shopt in bash, not
 * a set option, so bash rejects it and never reaches a prompt. Args that
 * already name the option are passed through untouched, which makes
 * `+o interactive_comments` the way to keep zsh's own default.
 */
export function resolveShellArgs(path: string, args: string[]): string[] {
  if (basename(path) !== "zsh") return args;
  // zsh option names ignore case and underscores, so the user's spelling of
  // the same option must count as naming it.
  if (args.some((a) => a.toLowerCase().replace(/_/g, "") === "interactivecomments")) return args;
  return [...args, "-o", "interactive_comments"];
}

/** Where a session's note lives, as validated facts: the note's own file and
 * the workspace root containing it. Derived and checked Bun-side (index.ts,
 * against the registry) — never taken from frontmatter. */
export interface SessionFacts {
  note: string;
  workspace: string;
}

// Stamp the session's location into a spawn env as LEDGE_NOTE and
// LEDGE_WORKSPACE — the deixis an agent in the note's shells needs to answer
// "the note I am sitting in" (the MCP server's read_note defaults to
// LEDGE_NOTE when called with no arguments).
//
// Applied AFTER every user layer, the same move as the TERM pin and for the
// same reason: these names are Ledge's, never the note's. A frontmatter (or
// profile, or envFile) that sets them is overridden when the facts exist and
// scrubbed when they do not — an unsaved note must read as "no note file",
// not as whatever its frontmatter claims.
export function stampSessionFacts(env: Record<string, string>, facts: SessionFacts | null): void {
  delete env["LEDGE_NOTE"];
  delete env["LEDGE_WORKSPACE"];
  if (facts) {
    env["LEDGE_NOTE"] = facts.note;
    env["LEDGE_WORKSPACE"] = facts.workspace;
  }
}

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

// A cwd that does not resolve to a real directory falls back to $HOME with a
// warning rather than being passed through: the spawn trampoline _exit(125)s
// on a failed chdir (pty.ts), so a stale path would kill the shell at birth
// and the terminal would just silently die — which reads as "Ledge is broken",
// not "your frontmatter names a folder that is gone".
function resolveCwd(cwd: string | null, home: string, deps: SpawnDeps): string {
  if (!cwd) return home;
  // Relative resolves against $HOME: it is the only anchor a note has (a
  // note's own path is not one — notes move on retitle).
  const expanded = expandTilde(cwd, home);
  const absolute = isAbsolute(expanded) ? expanded : resolve(home, expanded);
  if (deps.isDir(absolute)) return absolute;
  deps.warn(`cwd "${cwd}" is not a directory; spawning in ${home}`);
  return home;
}

function mergeDotenv(env: Record<string, string>, path: string, label: string, deps: SpawnDeps): void {
  const text = deps.readFile(path);
  if (text === null) {
    deps.warn(`${label}: no readable file at ${path}; skipping it`);
    return;
  }
  const { vars, problems } = parseDotenv(text);
  for (const p of problems) deps.warn(`${label}: ${p}`);
  Object.assign(env, vars);
}
