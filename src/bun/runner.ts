// Turns one fenced block into the line its note's shell will run, the only
// part of a run that varies by language. Every block goes through the note's
// zsh (inlinePool.ts), so the OSC 133 markers keep slicing output per block
// (markers.ts). Shell blocks are `source`d, since sourcing is the only way
// their cd and export reach the note's next block. Interpreted blocks (python,
// node, ...) run their temp file under an interpreter, a child of the shell
// that inherits the note's cwd and env but cannot change them. The interpreter
// comes from settings.blocks.interpreters, resolved by the shell against its
// own PATH (architecture.md §6). This module is pure; server.ts writes the
// file and owns the shells.

/** What to write where, and the line that runs it. */
export interface RunnerSpec {
  // "shell" sources into the note's persistent shell. "interpreter" execs a
  // child. Callers branch on this: the terminal drawer pastes shell blocks as
  // their literal code (visible, editable, in history) but interpreted blocks
  // as their runner line.
  kind: "shell" | "interpreter";
  path: string;
  contents: string;
  command: string;
  // True when the block targets a remote host. `command` then carries the
  // block body in-band (base64 through the shell to the remote /tmp), and the
  // caller must not write `path` locally: it names a path on another machine.
  remote: boolean;
}

// Temp-file extension per fence language. Mostly cosmetic, since the
// interpreter is told the file explicitly. The exception is bun, which picks
// its TS or JS loader from the extension.
const EXT: Record<string, string> = {
  python: "py", python3: "py", py: "py",
  ruby: "rb", rb: "rb",
  node: "js", js: "js", javascript: "js",
  ts: "ts", typescript: "ts",
  php: "php",
};

/**
 * Returns what to pass as `bunPath` for a run on this machine: `execPath` when
 * the running binary is a bun, and "" when it is not. The app's main process
 * is a bun (Electrobun ships one as `Ledge.app/Contents/MacOS/bun`), so a
 * ```ts fence runs there with nothing installed. `ledge-server` is that same
 * bun with the server compiled into it, and a compiled binary runs only its
 * embedded program. It gets "" instead, so its fences use the PATH's `bun`:
 * they run where one is installed, and say "command not found" where none is
 * (remote.md §11).
 *
 * The check is the binary's name. A compiled binary is named after the program
 * inside it, never `bun`. daemon.ts checks the same way, for the same reason.
 */
export function bundledBun(execPath: string): string {
  return /(^|\/)bun$/.test(execPath) ? execPath : "";
}

/**
 * Builds the run for block `id`. `bunPath` is the bun this machine ships with,
 * or "" where it ships none (`bundledBun` above decides which), and the
 * interpreter value "bun" resolves to it, so TypeScript works with no bun
 * install. Each interpreted block runs as its own OS process, which keeps user
 * code out of the main process that owns the notes.
 *
 * `remote` builds the same run for a shell that lives on another machine
 * (bun/remoteSpawn.ts, architecture.md §6a). Two things change and only these
 * two. The temp file cannot be written from here, so the command sends the
 * body base64 through the shell into the remote /tmp and runs it there
 * (`remoteWrite` below; `--decode` is the spelling GNU and BSD share). And
 * "bun" means the remote PATH's bun, because the bundled one's absolute path
 * is meaningless on the remote host. The rest of the mapping (which languages
 * exist, extensions, the php tag) is the same on both paths, so a fence means
 * the same thing on every machine the note may target.
 */
export function runnerFor(
  id: string,
  lang: string | null,
  code: string,
  interpreters: Record<string, string>,
  bunPath: string,
  remote = false,
): RunnerSpec {
  const key = (lang ?? "").toLowerCase();
  const interpreter = interpreters[key];
  if (!interpreter) {
    const path = `/tmp/ledge-run-${id}.sh`;
    const command = remote ? remoteWrite(code, path, `source ${path}`) : `source ${path}`;
    return { kind: "shell", path, contents: code, command, remote };
  }
  // A user-mapped language with no entry in EXT falls back to the fence word
  // itself, scrubbed of punctuation. The fence line is note text, so it can
  // hold characters a temp-file name should not.
  const ext = EXT[key] ?? (key.replace(/[^a-z0-9]/g, "") || "txt");
  const path = `/tmp/ledge-run-${id}.${ext}`;
  // `php file` emits code outside <?php tags as literal output, and a php
  // fence in a note is usually the bare statements, so runnerFor adds the tag.
  const contents = ext === "php" && !/^\s*<\?/.test(code) ? `<?php\n${code}` : code;
  // `bunPath` is quoted because the app bundle can live under a path with
  // spaces. User values are left unquoted: they are commands, possibly with
  // flags. With no bundled bun, the line uses `bun run` off the PATH, the same
  // line a remote run gets.
  const cmd = interpreter === "bun" ? (remote || !bunPath ? "bun run" : `"${bunPath}" run`) : interpreter;
  const run = `${cmd} ${path}`;
  return { kind: "interpreter", path, contents, command: remote ? remoteWrite(contents, path, run) : run, remote };
}

// The in-band write-then-run for a remote block. The base64 alphabet contains
// no quote or shell metacharacter, so the single-quoted argument is inert in
// every POSIX shell, whatever the block body holds.
function remoteWrite(contents: string, path: string, run: string): string {
  const b64 = Buffer.from(contents, "utf8").toString("base64");
  return `printf '%s' '${b64}' | base64 --decode > ${path} && ${run}`;
}

/**
 * Returns the interpreter map for a run on `host` ("local", or an ssh
 * destination): the base `interpreters`, then every matching
 * `blocks.hostInterpreters` section merged over it in file order, later keys
 * winning. This is where "which python" gets its per-machine answer. The base
 * map is the local one and the default everywhere, and a host that installs
 * its interpreters somewhere else overrides only the languages it names
 * (settings.jsonc documents the shape).
 */
export function interpretersFor(
  host: string,
  blocks: { interpreters: Record<string, string>; hostInterpreters: Record<string, Record<string, string>> },
): Record<string, string> {
  const out = { ...blocks.interpreters };
  for (const [pattern, map] of Object.entries(blocks.hostInterpreters)) {
    if (hostGlobMatches(pattern, host)) Object.assign(out, map);
  }
  return out;
}

// `*` matches any run of characters. Everything else is literal, matched
// whole-string and case-sensitively (ssh config Host patterns are
// case-sensitive too, and an ssh alias's case is the user's own spelling).
// `*` is the whole grammar: numbered fleets ("deploy@anypost-*") are the use
// case, and nothing here needs full regex.
export function hostGlobMatches(pattern: string, host: string): boolean {
  const rx = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${rx}$`).test(host);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
