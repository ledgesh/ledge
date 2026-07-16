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
 */
export function runnerFor(
  id: string,
  lang: string | null,
  code: string,
  interpreters: Record<string, string>,
  bunPath: string,
): RunnerSpec {
  const key = (lang ?? "").toLowerCase();
  const interpreter = interpreters[key];
  if (!interpreter) {
    const path = `/tmp/ledge-run-${id}.sh`;
    return { kind: "shell", path, contents: code, command: `source ${path}` };
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
  const cmd = interpreter === "bun" ? `"${bunPath}" run` : interpreter;
  return { kind: "interpreter", path, contents, command: `${cmd} ${path}` };
}
