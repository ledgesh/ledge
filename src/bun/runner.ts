// Turns one fenced block into the line its note's shell will run.
//
// Every block still executes THROUGH the note's zsh (inlinePool.ts) so the
// OSC 133 marker protocol keeps slicing output per block; what varies by
// language is only the line we hand that shell. Shell blocks are `source`d so
// their cd/export persist into the note's next block — that persistence is the
// point of the persistent shell, and only sourcing can provide it. Interpreted
// blocks (python, node, ...) run their temp file under an interpreter instead:
// a child of the shell, so it inherits the note's cwd/env but cannot mutate
// them — which is the only semantics an interpreter can honestly offer.
//
// The interpreter is resolved by the shell from the command in
// settings.blocks.interpreters ("python3" means the login shell's PATH answers
// "which python", same as it would in the terminal drawer). Pure so the whole
// mapping is unit-testable; index.ts owns the file write and the shells.

/** What to write where, and the line that runs it. */
export interface RunnerSpec {
  // "shell" sources into the note's persistent shell; "interpreter" execs a
  // child. Callers branch on this: the terminal drawer pastes shell blocks as
  // their literal code (visible, editable, in history) but interpreted blocks
  // as their runner line.
  kind: "shell" | "interpreter";
  path: string;
  contents: string;
  command: string;
  // True when the block targets a remote host: `command` then carries the
  // block body in-band (base64 through the shell to the REMOTE /tmp) and the
  // caller must NOT write `path` locally — it is a path on another machine.
  remote: boolean;
}

// Temp-file extension per fence language. Mostly cosmetic — the interpreter is
// told the file explicitly — except for bun, which picks its TS/JS loader from
// the extension.
const EXT: Record<string, string> = {
  python: "py", python3: "py", py: "py",
  ruby: "rb", rb: "rb",
  node: "js", js: "js", javascript: "js",
  ts: "ts", typescript: "ts",
  php: "php",
};

/**
 * Build the run for block `id`. `bunPath` is the bun binary bundled with the
 * app (process.execPath — the main process IS that bun): the interpreter value
 * "bun" resolves to it so TypeScript works with no bun install, and as its own
 * OS process it keeps user code out of the main process that owns the notes.
 *
 * `remote` builds the same run for a shell that lives on another machine
 * (bun/remoteSpawn.ts). Two things change and only these two:
 * - The temp file cannot be written from here, so the command writes it
 *   in-band — the body rides base64 through the shell itself into the remote
 *   /tmp, then runs exactly as it would locally. base64 because it makes any
 *   body a single quiet argument (no quoting, no heredoc collisions), and
 *   `--decode` because that spelling is the one GNU and BSD share.
 * - "bun" means the REMOTE PATH's bun, not the bundled one: the bundle's
 *   absolute path is meaningless over there. A host without bun fails with
 *   the shell's own "command not found", which names the actual problem.
 * Everything else — which languages exist, extensions, the php tag — is the
 * same mapping, deliberately: a fence must mean the same thing on every
 * machine the note may target.
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
  // A user-mapped language we have no extension for uses the fence word
  // itself, scrubbed: the fence line is note text, and a temp-file name is no
  // place for its punctuation.
  const ext = EXT[key] ?? (key.replace(/[^a-z0-9]/g, "") || "txt");
  const path = `/tmp/ledge-run-${id}.${ext}`;
  // `php file` emits code outside <?php tags as literal output, and a php
  // fence in a note is usually the bare statements — supply the tag.
  const contents = ext === "php" && !/^\s*<\?/.test(code) ? `<?php\n${code}` : code;
  // Quoted because the app bundle can live under a path with spaces; user
  // values are NOT quoted (they are commands, possibly with flags).
  const cmd = interpreter === "bun" ? (remote ? "bun run" : `"${bunPath}" run`) : interpreter;
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
 * The interpreter map for a run on `host` ("local", or an ssh destination):
 * the base `interpreters` with every matching `blocks.hostInterpreters`
 * section merged over it, in file order, later keys winning. This is where
 * "which python" gets its per-machine answer — the base map is the local one
 * and the default everywhere, and a host whose toolchain lives elsewhere
 * overrides only the languages it names (settings.json documents the shape).
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

// `*` matches any run of characters; everything else is literal, whole-string,
// case-sensitive (ssh config Host patterns are case-sensitive too, and an ssh
// alias's case is the user's own spelling). The same deliberately tiny pattern
// language as .ledgeignore: numbered fleets ("deploy@anypost-*") are the use
// case, full regex is a tax.
export function hostGlobMatches(pattern: string, host: string): boolean {
  const rx = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${rx}$`).test(host);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
