// The `ledge` shim: how the CLI gets onto a PATH. It execs the exact runtime
// and entry that wrote it (process.execPath plus the CLI module's own path)
// and discovers nothing at run time: no bundle lookup, no PATH probe. The
// packaged app writes Contents/MacOS/bun and Resources/app/bun/cli.js, a
// checkout the dev machine's bun and src/bun/cli.ts (architecture.md §1).
// Re-running the install repoints a moved app. The shim's own text says so,
// because sh's "not found" error does not.
//
// The CLI's `install` verb and the app's cliInstall RPC both call installShim,
// so it lives apart from cli.ts. The app must not import the CLI's verb table
// (and the MCP server behind it) to write two lines of sh.
//
// installShim saves the shim the way every machine-owned file in this repo is
// saved: temp file, then rename (architecture.md §3). It refuses to write over
// a file that is not a Ledge shim. A bin directory is shared ground, and
// rename(2) clobbers silently.
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

// Double-quote a path for sh. The escapes cover what the double quotes do
// not: backslash, double quote, dollar and backtick. Machine-derived paths
// never need them, but a shim that silently broke on a space or a dollar sign
// would surface later as an error from the user's shell.
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

// Where a shim goes when the caller names no dir, most-visible first. The
// Homebrew bins are on a mac user's PATH when they exist at all, so they come
// before ~/.local/bin. installShim creates ~/.local/bin when it is missing and
// creates none of the others: /usr/local is not this app's to create.
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
  /** Candidate dirs to pick from. Tests inject their own so the pick never
   * probes the real /opt/homebrew/bin, which on a dev machine is writable, so
   * the test would write into it. */
  candidates?: readonly string[];
}): Promise<ShimInstall> {
  const home = opts.home ?? homedir();
  // installShim stats the entry before it writes anything. A shim whose entry
  // is missing still execs the runtime, which then reports the missing module
  // at first use, long after the install reported success.
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
    dir ??= join(home, ".local", "bin"); // nothing writable: create ~/.local/bin
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
    await unlink(tmp).catch(() => {}); // the dotted temp this call just wrote
    throw err;
  }
  return { path: target, onPath: dirOnPath(dir, opts.pathVar) };
}
