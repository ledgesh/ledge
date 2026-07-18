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
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
