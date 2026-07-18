// The `ledge` shim: how the CLI gets onto a PATH. One rule covers every
// context — the shim execs the exact runtime and entry that WROTE it
// (process.execPath plus the CLI module's own path), which is the packaged
// app's Contents/MacOS/bun + Resources/app/bun/cli.js when the app installs
// it, and the dev machine's bun + src/bun/cli.ts when a checkout does. No
// bundle discovery and no PATH probing at run time: the shim is a two-line
// fact, and a moved app is fixed by running the install again — the shim's
// own comment says so, because that fact is not guessable from "not found".
//
// Shared by the CLI's `install` verb and the app's cliInstall RPC, which is
// why it lives apart from cli.ts: the app must not import the CLI's verb
// table (and the MCP server behind it) to write two lines of sh.
//
// Written like every machine-owned file in this repo: temp-plus-rename, and
// NEVER over a file that is not recognizably ours — a bin dir is shared
// ground, and rename(2) clobbers silently.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants, promises } from "node:fs";

/** First line of the shim's comment; how a later install recognizes its own. */
export const SHIM_MARKER = "# Ledge CLI shim";

/** ~-shorten a path for human eyes. Lives here (not cli.ts) so the app's
 * install handler can compose messages without importing the verb table. */
export function tildify(p: string, home: string = homedir()): string {
  const h = resolve(home);
  const r = resolve(p);
  if (r === h) return "~";
  return r.startsWith(h + "/") ? `~${r.slice(h.length)}` : p;
}

// Double-quote a path for sh. The escapes cover what double quotes do not:
// machine-derived paths never need them, but a shim that silently broke on a
// space or a dollar sign would fail as the USER's shell error, not ours.
function shQuote(p: string): string {
  return `"${p.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

export function shimScript(execPath: string, entryPath: string): string {
  return [
    "#!/bin/sh",
    `${SHIM_MARKER} — written by \`ledge install\` (or the app's Install Shell Command).`,
    "# It execs the exact runtime and entry that wrote it; if the app has",
    "# moved, run the install again to repoint it.",
    `exec ${shQuote(execPath)} ${shQuote(entryPath)} "$@"`,
    "",
  ].join("\n");
}

export function isLedgeShim(text: string): boolean {
  return text.includes(SHIM_MARKER);
}

/** Is `dir` one of PATH's entries? The onPath answer in an install result. */
export function dirOnPath(dir: string, pathVar: string): boolean {
  const d = resolve(dir);
  return pathVar.split(":").some((p) => p !== "" && resolve(p) === d);
}

// Where a shim goes when the caller names no dir, most-visible first: the
// Homebrew bins are on a mac user's PATH when they exist at all, and
// ~/.local/bin is the one we may create ourselves — growing a directory in
// /usr/local is a package manager's job, not a notes app's.
export function shimDirCandidates(home: string): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin")];
}

async function writableDir(d: string): Promise<boolean> {
  try {
    if (!(await stat(d)).isDirectory()) return false;
    await promises.access(d, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ShimInstall {
  /** Where the shim landed. */
  path: string;
  /** Whether that directory is on the caller's PATH right now. */
  onPath: boolean;
}

export async function installShim(opts: {
  execPath: string;
  entryPath: string;
  /** The caller's $PATH, for the onPath answer. */
  pathVar: string;
  /** Explicit target directory; null picks from the candidates. */
  dir?: string | null;
  home?: string;
  /** Candidate dirs for the pick — injectable so tests never probe the real
   * /opt/homebrew/bin (which would be writable, and written). */
  candidates?: readonly string[];
}): Promise<ShimInstall> {
  const home = opts.home ?? homedir();
  // The entry must exist NOW: a shim pointing at nothing would fail at first
  // use as sh's error, long after the install claimed success.
  const entryOk = await stat(opts.entryPath).then((s) => s.isFile()).catch(() => false);
  if (!entryOk) throw new Error(`the CLI entry is missing at ${opts.entryPath} — rebuild the app`);

  let dir = opts.dir ?? null;
  if (dir === null) {
    for (const c of opts.candidates ?? shimDirCandidates(home)) {
      if (await writableDir(c)) {
        dir = c;
        break;
      }
    }
    dir ??= join(home, ".local", "bin"); // nothing writable: grow the user's own
  }
  await mkdir(dir, { recursive: true });

  const target = join(dir, "ledge");
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== null && !isLedgeShim(existing)) {
    throw new Error(`refusing to overwrite ${target} — it exists and is not a Ledge shim`);
  }

  const tmp = join(dir, `.ledge-shim-tmp-${process.pid}`);
  try {
    await writeFile(tmp, shimScript(opts.execPath, opts.entryPath), "utf8");
    await chmod(tmp, 0o755); // explicit, not writeFile's mode: umask must not decide
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // our own dotted temp, moments old
    throw err;
  }
  return { path: target, onPath: dirOnPath(dir, opts.pathVar) };
}
