// Turns a session's NoteParams (frontmatter, sent over sessionConfigure) into
// the cwd and env its shells spawn with. Precedence and the TERM pin are the
// contract in architecture.md §6a. cwd resolves first because a relative
// envFile resolves against it. Every failure warns and degrades instead of
// throwing: a missing profile contributes nothing, an unusable cwd spawns the
// shell in $HOME.
//
// The filesystem is injected (`SpawnDeps`) so this policy is testable without
// touching disk, the same move as InlinePool's injected spawn. server.ts
// passes the real fs.
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isEnvName, isProfileName, type NoteParams } from "../shared/frontmatter";
import { parseDotenv } from "../shared/dotenv";

// Profiles live outside the notes root, because ~/.ledge is the folder people
// sync and back up, and profile files hold secrets (architecture.md §6a).
//
// LEDGE_PROFILES_DIR overrides the path so a test or a live probe never reads
// or seeds the real profiles, the same escape hatch as LEDGE_NOTES_ROOT
// (bun/workspaces.ts). Nothing in the app sets it.
export const PROFILES_DIR =
  process.env["LEDGE_PROFILES_DIR"] ?? join(homedir(), ".config", "ledge", "profiles");

// Env vars by which a terminal app announces that a shell runs inside it. The
// app inherits them from whatever terminal launched it (`bun run dev` in a
// cmux pane, say). Inside a Ledge PTY every one is false, and passing them
// through makes note shells masquerade as panes of that terminal. Same stance
// as the TERM pin. Not cosmetic: cmux ships a `claude` PATH shim that sees
// CMUX_SURFACE_ID and injects session-tracking hooks. Those hooks then fail
// ("Hook cancelled") at the end of a session cmux never owned, and every
// prompt block ran with that error appended (architecture.md §6a). Scrubbed
// from the base layer only, so `env:` or a profile can set one back.
const HOST_TERMINAL_PREFIXES = ["CMUX_", "GHOSTTY_", "ITERM_", "WEZTERM_", "KITTY_", "ALACRITTY_"];
const HOST_TERMINAL_VARS = new Set(["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "STY"]);

function scrubHostTerminal(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (HOST_TERMINAL_VARS.has(key) || HOST_TERMINAL_PREFIXES.some((p) => key.startsWith(p))) delete env[key];
  }
}

export interface SpawnDeps {
  // null for unreadable or missing. Both mean the file contributes nothing.
  readFile: (path: string) => string | null;
  isDir: (path: string) => boolean;
  warn: (msg: string) => void;
}

export interface ResolvedSpawn {
  cwd: string;
  env: Record<string, string>;
}

/**
 * The cwd and env for one session's next shell. `params` is what the view last
 * sent over sessionConfigure. undefined means the note sent none, and must
 * resolve to what shells got before params existed: the base env, in $HOME.
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
    // Re-validated here, not just in the parser. The parser's check is a typo
    // message for the honest path. This one guards the RPC path, where a
    // profile name arrives from the least-trusted end (architecture.md §2)
    // and becomes a filename.
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

  // TERM is pinned last, whatever any layer set it to. xterm.js is the
  // terminal, so a note that exports TERM gets a broken one, not a different
  // one.
  if (baseEnv["TERM"]) env["TERM"] = baseEnv["TERM"];
  return { cwd, env };
}

// --- which shell binary ------------------------------------------------------

/**
 * The shells whose block output Ledge can slice. `markerInit` (bun/markers.ts)
 * installs its OSC 133 end-marker hook as `precmd_functions` under zsh and as
 * `PROMPT_COMMAND` under every other shell, and `PROMPT_COMMAND` is bash's.
 * Under dash (Debian's `/bin/sh`) the hook lands and does nothing, and under
 * fish the init line is not valid syntax. Commands still run in both, and no
 * block ever ends: no output and no exit code reach the panel. Two shells
 * work, so one outside the set has to be warned about (`shellCaveat` below)
 * rather than accepted in silence.
 */
export const SUPPORTED_SHELLS = ["zsh", "bash"] as const;

// Tried in order when the login shell is not a supported one. zsh comes first
// because /bin/zsh is always present on macOS and rarely on Linux. One fixed
// order then picks the platform's own shell on both, without having to ask
// which platform it is on.
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
 * The login shell comes first because `shell.args` defaults to `-i`, so the
 * shell sources the user's rc files. Spawning zsh on a box whose owner lives
 * in `.bashrc` gives a prompt with none of their PATH, aliases or functions.
 *
 * Returns null when nothing supported is installed, so the caller can report
 * that rather than guessing at a shell. Pure, so the ladder is testable
 * without a filesystem. `defaultShellPath` supplies the real probe.
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
 * Why this shell cannot be spawned at all, or null if it can. The failure it
 * prevents is invisible: the C trampoline (`dist-native/ledge_pty.c`) forks
 * and then execs, so a missing binary is the child's error. `fork` succeeds,
 * pty.ts sees a valid pid and reports a healthy spawn, and the master fd only
 * carries the tty echoing the input back. Refusing before the fork gives the
 * caller a message to show instead.
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
 * Separate from the refusal above because the damage is partial: an
 * unsupported shell gives a working terminal drawer and broken inline runs.
 * Refusing to spawn it would take away the half that works.
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
 * The argv a local shell spawns with: `settings.shell.args`, plus
 * `-o interactive_comments` when that shell is zsh. The flag keeps `#` a
 * comment on both chords: an inline run sources the block as a file
 * (bun/runner.ts), while the drawer types it into zsh's line editor, where the
 * option is off unless asked for (docs/user/02-running-code.md).
 *
 * An argv flag rather than a `setopt` line written into the pty: the drawer
 * shows every byte its shell receives, so an injected command would print
 * above the first prompt and stay in the user's history.
 */
export function resolveShellArgs(path: string, args: string[]): string[] {
  // zsh only, by binary name. bash already enables the option for interactive
  // shells, and there it is a shopt rather than a set option, so bash would
  // reject `-o interactive_comments` and never reach a prompt.
  if (basename(path) !== "zsh") return args;
  // Args that already name the option pass through untouched, so
  // `+o interactive_comments` keeps zsh's own default. zsh option names ignore
  // case and underscores, so the user's spelling of the same option counts as
  // naming it.
  if (args.some((a) => a.toLowerCase().replace(/_/g, "") === "interactivecomments")) return args;
  return [...args, "-o", "interactive_comments"];
}

/** Where a session's note lives, as validated facts: the note's own file and
 * the workspace root containing it. Derived and checked Bun-side against the
 * registry (server.ts, `sessionConfigure`). Never taken from frontmatter. */
export interface SessionFacts {
  note: string;
  workspace: string;
}

// Stamps the session's location into a spawn env as LEDGE_NOTE and
// LEDGE_WORKSPACE, so an agent running in the note's shells can name the note
// it sits in (the MCP server's read_note defaults to LEDGE_NOTE when called
// with no arguments).
//
// Applied after every user layer, the same move as the TERM pin: these names
// are Ledge's, never the note's. A frontmatter, profile or envFile that sets
// one is overridden when the facts exist, and cleared when they do not. An
// unsaved note then reads as "no note file" rather than as whatever its
// frontmatter claims.
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

// A cwd that does not name a real directory falls back to $HOME with a warning
// rather than being passed through. The spawn trampoline `_exit(125)`s on a
// failed chdir (dist-native/ledge_pty.c), so a stale path would end the shell
// before it ran anything, and the terminal would show nothing to say why.
function resolveCwd(cwd: string | null, home: string, deps: SpawnDeps): string {
  if (!cwd) return home;
  // Relative resolves against $HOME, the only anchor a note has. A note's own
  // path is not one: notes move on retitle.
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
