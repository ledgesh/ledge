// The `ledge` shim: how this Mac's app gets the command onto a PATH. It execs
// the exact runtime and entry that wrote it, the bundle's own bun on its
// serve.js, and discovers nothing at run time. A checkout writes the dev
// machine's bun and src/bun/serve.ts. Re-running the install repoints a moved
// app. The shim's own text says so, because sh's "not found" does not.
//
// It goes in ~/.ledge/.server/bin, the directory the ssh command every client
// runs puts first on PATH (shared/connections.ts SERVE_COMMAND). That is what
// makes this Mac a server for a phone: `ledge serve` over ssh finds the app's
// own copy and attaches to the app's own daemon. server.sh installs a server
// into the same directory on a machine without the app (remote.md §11), so
// the two installers overwrite each other's launcher and nothing else's. A
// `ledge` from a Homebrew keg keeps its file.
//
// The client's seam, not the server's (remote.md §10): the file lands on the
// machine with the screen, and it runs that machine's copy. installShims
// saves it the way every machine-owned file here is saved: temp file, then
// rename (architecture.md §3).
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

/** First line of a shim's comment; how a later install recognizes its own. */
export const SHIM_MARKER = "# Ledge shim";

/** What server.sh writes into the same launcher; the app may replace it. */
const SERVER_SH_MARKER = "ledge.sh/server.sh";

/** The one command. */
export const SHIM_NAME = "ledge";

/** The line server.sh appends for the same purpose, spelled identically so
 * each installer recognizes the other's. */
export const PATH_LINE = 'export PATH="$HOME/.ledge/.server/bin:$PATH"';

/** ~-shorten a path for human eyes. Lives here (not cli.ts) so the app's
 * install handler can compose messages without importing the verb table. */
export function tildify(p: string, home: string = homedir()): string {
  const h = resolve(home);
  const r = resolve(p);
  if (r === h) return "~";
  return r.startsWith(h + "/") ? `~${r.slice(h.length)}` : p;
}

/** Where the shim goes, under `home`. */
export function shimDir(home: string = homedir()): string {
  return join(home, ".ledge", ".server", "bin");
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
    `${SHIM_MARKER}, written by the Ledge app's Install Shell Command.`,
    "# It execs the exact runtime and entry that wrote it; if the app has",
    "# moved, run the install again to repoint it.",
    `exec ${shQuote(execPath)} ${shQuote(entryPath)} "$@"`,
    "",
  ].join("\n");
}

export function isLedgeShim(text: string): boolean {
  return text.includes(SHIM_MARKER) || text.includes(SERVER_SH_MARKER);
}

/** Is `dir` one of PATH's entries? The onPath answer in an install result. */
export function dirOnPath(dir: string, pathVar: string): boolean {
  const d = resolve(dir);
  return pathVar.split(":").some((p) => p !== "" && resolve(p) === d);
}

/**
 * The startup file a login shell reads for a new terminal, or null for a
 * shell whose file the PATH line's syntax would not suit. The same table as
 * server.sh's add_to_path, so the two installers edit the same file.
 */
export function startupFile(shellVar: string, home: string, platform: string = process.platform): string | null {
  const shell = shellVar.split("/").pop() ?? "";
  if (shell === "zsh") return join(home, ".zshrc");
  if (shell === "bash") return join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
  if (shell === "fish" || shell === "csh" || shell === "tcsh") return null;
  return join(home, ".profile");
}

export interface ShimInstall {
  /** Where the shim landed. */
  dir: string;
  /** Whether that directory was on the caller's PATH already. */
  onPath: boolean;
  /** The startup file the PATH line was appended to, or null when it was not:
   * the directory was on PATH, the file already named it, or the login shell
   * is one the line cannot go in. */
  pathAdded: string | null;
}

export async function installShims(opts: {
  execPath: string;
  entryPath: string;
  /** The caller's $PATH, for the onPath answer. */
  pathVar: string;
  /** The caller's $SHELL, for which startup file gets the PATH line. */
  shellVar: string;
  home?: string;
  platform?: string;
}): Promise<ShimInstall> {
  const home = opts.home ?? homedir();
  // The entry is checked before anything is written. A shim whose entry is
  // missing still execs the runtime, which then reports the missing module at
  // first use, long after the install reported success.
  const entryOk = await stat(opts.entryPath).then((s) => s.isFile()).catch(() => false);
  if (!entryOk) throw new Error(`the server entry is missing at ${opts.entryPath}: rebuild the app`);

  const dir = shimDir(home);
  await mkdir(dir, { recursive: true });

  // A bin directory is shared ground, and rename(2) clobbers silently, so a
  // file that is not ours stays.
  const target = join(dir, SHIM_NAME);
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== null && !isLedgeShim(existing)) {
    throw new Error(`refusing to overwrite ${target}: it exists and is not a Ledge shim`);
  }
  const tmp = join(dir, `.${SHIM_NAME}-tmp-${process.pid}`);
  try {
    await writeFile(tmp, shimScript(opts.execPath, opts.entryPath), "utf8");
    await chmod(tmp, 0o755); // explicit, not writeFile's mode: umask must not decide
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // the dotted temp this call just wrote
    throw err;
  }

  const onPath = dirOnPath(dir, opts.pathVar);
  return { dir, onPath, pathAdded: onPath ? null : await addPathLine(opts.shellVar, home, opts.platform) };
}

// Appends PATH_LINE to the login shell's startup file, once. The grep is
// server.sh's: any line naming the directory counts, so a user's own line or
// the other installer's is left alone.
async function addPathLine(shellVar: string, home: string, platform?: string): Promise<string | null> {
  const file = startupFile(shellVar, home, platform);
  if (file === null) return null;
  const text = await readFile(file, "utf8").catch(() => "");
  if (text.includes(".ledge/.server/bin")) return null;
  await appendFile(file, `\n# ledge (the Ledge app's Install Shell Command)\n${PATH_LINE}\n`, "utf8");
  return file;
}
