// Per-note shell parameters, read from a YAML-subset frontmatter block at the
// top of the note.
//
// Shared because both ends need it and they must agree: the view parses a
// note's frontmatter to send spawn params over sessionConfigure, and slug.ts
// uses the block's extent so a frontmatter note's title is still its first
// content line, not "---". Hand-rolled rather than a yaml dependency
// (architecture.md §8): the accepted grammar is deliberately a flat
// `key: value` list plus one indented map under `env:`, which is ~all of what
// these params need and small enough to be fully specified by its tests.
//
// Only the block's SHAPE lives here. What the values mean at spawn — ~
// expansion, cwd fallback, profile file resolution, env precedence — is
// Bun-side policy, applied where the shell is spawned.
//
// Validation degrades per line, parseSettings-style: a bad line costs that
// line (reported in `problems`, so the UI can surface it), never the rest of
// the block and never a crash. The note is hand-edited text; a typo has to
// degrade as gently as one in settings.json does.

/** Spawn parameters a note may declare. null / {} mean "not declared". */
export interface NoteParams {
  // Working directory for the note's shells (inline-run, overflow, terminal).
  cwd: string | null;
  // Named secrets scope: resolves Bun-side to <profiles dir>/<name>.env, so
  // the note carries only the name, never the values.
  profile: string | null;
  // A project-owned dotenv file, resolved against cwd at spawn.
  envFile: string | null;
  // Inline non-secret vars, merged over the spawn env.
  env: Record<string, string>;
}

export interface Frontmatter {
  params: NoteParams;
  problems: string[];
  // Offset of the first content character after the closing fence (0 when the
  // note has no frontmatter). This is the one field slug.ts and the editor's
  // block styling need; they must agree with the parser on where the block
  // ends, which is why it is returned rather than recomputed.
  end: number;
}

// Exactly three dashes, alone on the line. `\s*$` swallows trailing spaces and
// a stray \r (pasted CRLF text) — both invisible, so both would otherwise make
// a block silently stop being one.
const FENCE = /^---\s*$/;

// The profile name becomes a filename under the profiles dir, so it is safe by
// construction or not accepted at all — the same trust move as slugify: no
// separators and no dots means no traversal, no ".env"-style hidden files, and
// nothing to escape. Exported because Bun re-checks the name at resolution
// (bun/spawnParams.ts): the view is the least-trusted end of the RPC, so the
// parser's check is the typo message and Bun's is the guard — and they must be
// the SAME predicate, or a name could pass one and surprise the other.
export function isProfileName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

// Env var names as execve and every shell agree on them. Anything else (spaces,
// "=", unicode) would be legal in envp but unreachable from a shell, which for
// a notes app means it is a typo. Shared with the dotenv parsing in
// bun/spawnParams.ts: what counts as a usable name must not depend on which
// file it was written in.
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Where a note's frontmatter block ends: the offset just past the closing
 * fence's newline, or 0 if the note has none. A block only exists when the
 * note's very FIRST line is `---` and a closing `---` line follows: an
 * unterminated opener is treated as content (it is a markdown thematic break),
 * not as a block that swallowed the whole note.
 */
export function frontmatterEnd(text: string): number {
  const firstNl = text.indexOf("\n");
  if (firstNl === -1) return 0; // one line total: nothing can close a fence
  if (!FENCE.test(text.slice(0, firstNl))) return 0;
  let pos = firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (FENCE.test(line)) return nl === -1 ? text.length : nl + 1;
    if (nl === -1) break;
    pos = nl + 1;
  }
  return 0;
}

/** Parse a note's frontmatter into spawn params (see the header for grammar). */
export function parseFrontmatter(text: string): Frontmatter {
  const end = frontmatterEnd(text);
  const params: NoteParams = { cwd: null, profile: null, envFile: null, env: {} };
  const problems: string[] = [];
  if (end === 0) return { params, problems, end };

  // The lines between the fences: after the opener's newline, up to (not
  // including) the closing fence line itself.
  const innerStart = text.indexOf("\n") + 1;
  const inner = text.slice(innerStart, end).replace(/\r?\n?---\s*$/, "");

  // Indented lines are only meaningful directly under `env:`; this tracks
  // whether we are inside that map.
  let inEnv = false;

  for (const rawLine of inner.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    // Blank lines and full-line comments are structure-neutral: they neither
    // end the env map nor start one. (Inline comments are NOT stripped — a
    // value may legitimately contain "#", as in a URL fragment.)
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      problems.push(`not a "key: value" line: "${trimmed}"`);
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const value = unquote(trimmed.slice(colon + 1).trim());

    if (/^\s/.test(line)) {
      if (!inEnv) {
        problems.push(`indented line outside "env:": "${trimmed}"`);
        continue;
      }
      if (!isEnvName(key)) {
        problems.push(`"env.${key}" is not a usable variable name`);
        continue;
      }
      if (!value) {
        problems.push(`"env.${key}" has no value`);
        continue;
      }
      params.env[key] = value;
      continue;
    }

    inEnv = false;
    switch (key) {
      case "env":
        if (value) problems.push(`"env" takes indented NAME: value lines, not an inline value`);
        else inEnv = true;
        break;
      case "cwd":
      case "envFile":
        if (value) params[key] = value;
        else problems.push(`"${key}" must be a non-empty value`);
        break;
      case "profile":
        if (!value) problems.push(`"profile" must be a non-empty value`);
        else if (!isProfileName(value)) problems.push(`"profile" must be letters, digits, "-" or "_": "${value}"`);
        else params.profile = value;
        break;
      default:
        // Same reasoning as parseSettings: a misspelled key silently ignored
        // reads as "my frontmatter does nothing" — say so instead.
        problems.push(`unknown key "${key}"`);
    }
  }

  return { params, problems, end };
}

// Strip one pair of wrapping quotes, so `cwd: "~/My Notes"` means what it
// looks like. Only a matched, wrapping pair: a value that merely contains a
// quote passes through untouched. Exported for the dotenv parsing in
// bun/spawnParams.ts, which quotes by the same rule: a value must mean the
// same thing whether it was written in a note or in a profile file.
export function unquote(v: string): string {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}
