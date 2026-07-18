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

/** Parameters a note may declare. null / {} / [] mean "not declared". */
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
  // The machines this note's blocks may execute on: ssh destinations
  // (`user@host`, an ssh-config alias), or the reserved word "local". Empty
  // means undeclared — everything runs locally, as before the key existed.
  // More than one entry means every run asks which member to target; the list
  // is an allowlist, enforced Bun-side (bun/index.ts resolveHost).
  hosts: string[];
  // The note's declared tags, spelled as written (leading "#" stripped;
  // identity is case-folded at comparison time, shared/tags.ts normalizeTag).
  // The one key that never feeds a spawn: it lives here — and rides
  // sessionConfigure inertly — because the block has ONE parser, not because
  // the shell cares. Inline #hashtags in the body are the other tag source;
  // shared/tags.ts tagRefsOf merges the two.
  tags: string[];
  // Whether the note declares itself a template (`template: true`): the note
  // appears in the "New Note from Template…" picker, and instantiating it
  // strips this line (shared/template.ts) so instances are not templates too.
  // The value `daily` claims a ROLE on top of that: this template is the one
  // ⌘J / `ledge today` instantiates for each day's note (bun/daily.ts
  // findDailyTemplate). In the corpus rather than in settings.json
  // deliberately: which notes are templates — and which one is the daily —
  // is a fact about the notes, and marking one is editing a note: no
  // registry to keep in sync, no restart to apply it, nothing to go stale
  // when the note retitles. Like tags, it never feeds a spawn; it lives here
  // because the block has one parser.
  template: boolean | "daily";
}

/** The reserved `host:` member meaning "this machine, no ssh". */
export const LOCAL_HOST = "local";

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

// An ssh destination (`host`, `user@host`, an ssh-config alias) or "local".
// The charset covers all of those; what it excludes is what matters: a leading
// "-" would read as an ssh OPTION when the destination becomes argv (option
// injection), and whitespace/quotes/commas never appear in a real destination
// but would break the list syntax and the remote command line. Same
// parser-checks/Bun-guards split as isProfileName: the view's check is the
// typo message, Bun re-applies the SAME predicate where the value is used
// (bun/index.ts resolveHost).
export function isHostName(name: string): boolean {
  return /^[A-Za-z0-9_.@:-]+$/.test(name) && !name.startsWith("-");
}

// A tag as BOTH grammars accept it: the inline `#tag` scanner
// (shared/tags.ts) and the `tags:` list here must agree on what counts as a
// tag, or a note could declare a tag it can never write inline. Letters (any
// script), digits, "_", "-", "/" — and at least one letter or "_", so `#123`
// and `#2024` stay plain text (an issue number, a year — not a tag). "/" is
// an accepted spelling (`project/ledge`) with no hierarchy semantics.
export function isTagToken(token: string): boolean {
  return /^[\p{L}\p{N}_/-]+$/u.test(token) && /[\p{L}_]/u.test(token);
}

/**
 * Split a `tags:` value into its accepted tags and the tokens refused.
 * `tag` is the spelling with any leading "#" stripped; `raw` is the token
 * exactly as written (the reveal re-finds it on the line). Case-folded
 * dedupe, first spelling wins. Exported for shared/tags.ts, which locates
 * the `tags:` line for occurrence refs: what the two ends accept from that
 * line must be the SAME list, so the split lives once, here.
 */
export function splitTagList(value: string): {
  accepted: { tag: string; raw: string }[];
  rejected: string[];
} {
  const accepted: { tag: string; raw: string }[] = [];
  const rejected: string[] = [];
  for (const token of value.split(/[,\s]+/)) {
    if (!token) continue;
    const tag = token.startsWith("#") ? token.slice(1) : token;
    if (!isTagToken(tag)) rejected.push(token);
    else if (!accepted.some((a) => a.tag.toLowerCase() === tag.toLowerCase())) {
      accepted.push({ tag, raw: token });
    }
  }
  return { accepted, rejected };
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
  const params: NoteParams = { cwd: null, profile: null, envFile: null, env: {}, hosts: [], tags: [], template: false };
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
      case "host": {
        // One line, space- or comma-separated: `host: web1, deploy@prod`.
        // Neither separator can appear in a real ssh destination, so a flat
        // list needs no new grammar. Per-token degradation, env-style: a bad
        // token costs itself, the machines beside it stay reachable.
        if (!value) {
          problems.push(`"host" must name at least one machine (or "local")`);
          break;
        }
        params.hosts = []; // a repeated host: line replaces, like every other key
        for (const token of value.split(/[,\s]+/)) {
          if (!token) continue;
          if (!isHostName(token)) problems.push(`"host" entry is not an ssh destination: "${token}"`);
          else if (!params.hosts.includes(token)) params.hosts.push(token);
        }
        break;
      }
      case "tags": {
        // One line, space- or comma-separated: `tags: work, #project/ledge`.
        // A leading "#" per token is accepted and stripped — people write
        // tags the way the body spells them. Per-token degradation,
        // host-style: a bad token costs itself, the tags beside it survive.
        if (!value) {
          problems.push(`"tags" must name at least one tag`);
          break;
        }
        const { accepted, rejected } = splitTagList(value);
        params.tags = accepted.map((a) => a.tag); // a repeated tags: line replaces
        for (const bad of rejected) {
          problems.push(`"tags" entry is not a tag (letters, digits, "_", "-", "/"): "${bad}"`);
        }
        break;
      }
      case "template":
        // Exactly true, false, or daily: any other value is a typo, and
        // defaulting a typo to "is a template" would surprise harder than
        // the reverse.
        if (value === "true") params.template = true;
        else if (value === "false") params.template = false;
        else if (value === "daily") params.template = "daily";
        else problems.push(`"template" must be true, false, or daily: "${value}"`);
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
