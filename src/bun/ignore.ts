// What the note walk skips beyond dot-entries (bun/notes.ts listNotes): the
// well-known vendor/build directories, and whatever the workspace's own
// `.ledgeignore` says. An attached project folder should contribute its
// handful of real notes, not every README and CHANGELOG under node_modules.
//
// This is VISIBILITY, not a guard: an ignored note is merely absent from the
// browser and search. The path guards stay registry-based (workspaces.ts), so
// a note that was open when it became ignored still saves — losing edits to a
// config file would be worse than listing one note too many.
//
// The grammar is a deliberately small gitignore subset, hand-rolled per
// architecture.md §8, one line per pattern, degrading per line:
//
//   #  comment; blank lines skipped
//   name          matches a file or directory NAME at any depth (drafts)
//   name/         directory-only (the trailing slash)
//   a/b           contains a slash: anchored to the workspace root
//   *.wip.md      * and ? glob within a path segment (never across /)
//   !pattern      re-include: last matching line wins (gitignore's rule)
//
// The defaults are listed first, so a `.ledgeignore` line like `!build` can
// win a workspace's real build/ folder back. No `**` (a name pattern already
// matches at any depth), and re-including inside an ignored directory cannot
// work — the walk prunes the directory before ever seeing its children.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Directory names skipped by default, at any depth. Exact names only, and
// directories only: a note slugged build.md is not a build system. Kept to
// the near-universal conventions — anything more opinionated belongs in the
// workspace's own .ledgeignore.
export const DEFAULT_IGNORED_DIRS = [
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__pycache__",
  "Pods",
  "DerivedData",
] as const;

export const LEDGEIGNORE = ".ledgeignore";

interface Pattern {
  re: RegExp;
  // Matches against the full root-relative path (held a "/") vs the entry name.
  anchored: boolean;
  dirOnly: boolean;
  negated: boolean;
}

export interface IgnoreMatcher {
  /** `rel` is the entry's path relative to the workspace root. */
  ignores(rel: string, isDir: boolean): boolean;
  /** Lines that could not be used, for the caller to log. */
  problems: string[];
}

// One glob segment to regex source: * and ? stay within a segment, everything
// else is literal. Split on the globs first so the rest can be escaped whole.
function globToRe(pattern: string): string {
  return pattern
    .split(/([*?])/)
    .map((part) => (part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
}

function compile(line: string): Pattern | null {
  let p = line;
  const negated = p.startsWith("!");
  if (negated) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  // A leading slash is an explicit anchor (gitignore spelling); any interior
  // slash anchors too, since a relative path only means something from the
  // root. Decide BEFORE stripping the leading slash, or "/scratch" would
  // degrade to a match-anywhere name pattern.
  let anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  if (p === "") return null;
  anchored = anchored || p.includes("/");
  return { re: new RegExp(`^${globToRe(p)}$`), anchored, dirOnly, negated };
}

/** Compile `.ledgeignore` text (plus the defaults) into a matcher. Pure. */
export function parseIgnore(text: string): IgnoreMatcher {
  const problems: string[] = [];
  const patterns: Pattern[] = DEFAULT_IGNORED_DIRS.map((name) => ({
    re: new RegExp(`^${globToRe(name)}$`),
    anchored: false,
    dirOnly: true,
    negated: false,
  }));
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const pat = compile(line);
    if (pat) patterns.push(pat);
    else problems.push(`unusable pattern: "${raw.trim()}"`);
  }
  return {
    problems,
    ignores(rel: string, isDir: boolean): boolean {
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      let ignored = false;
      for (const p of patterns) {
        if (p.dirOnly && !isDir) continue;
        if (p.re.test(p.anchored ? rel : name)) ignored = !p.negated;
      }
      return ignored;
    },
  };
}

/**
 * The matcher for one workspace root, read fresh per walk: the file is one
 * small read against a directory scan, and editing it takes effect on the
 * next refresh with no reload story. Missing file (almost every workspace)
 * means defaults only; an unreadable line costs itself and is logged.
 */
export async function loadIgnore(root: string): Promise<IgnoreMatcher> {
  const text = await readFile(join(root, LEDGEIGNORE), "utf8").catch(() => "");
  const matcher = parseIgnore(text);
  for (const p of matcher.problems) console.warn(`[notes] ${LEDGEIGNORE} in ${root}: ${p}`);
  return matcher;
}
