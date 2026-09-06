// What the note walk skips beyond dot-entries (bun/notes.ts listNotes): the
// well-known vendor and build directories, plus whatever the workspace's own
// `.ledgeignore` says. An attached project folder should contribute its
// handful of real notes, not every README and CHANGELOG under node_modules.
//
// An ignore rule hides a note. It does not protect it: the path guards stay
// registry-based (workspaces.ts), so a note that was open when it became
// ignored still saves, because losing edits to a config file would be worse
// than listing one note too many. Writing is the exception: ensureFolder and
// renameFolder (bun/notes.ts) refuse an ignored name, since a note there
// would never appear in the list.
//
// The grammar is a small gitignore subset, hand-rolled per architecture.md
// §8. An unusable line is skipped and the rest of the file still applies.
// One line per pattern:
//
//   #  comment; blank lines skipped
//   name          matches a file or directory name at any depth (drafts)
//   name/         directory-only (the trailing slash)
//   a/b           contains a slash: anchored to the workspace root
//   *.wip.md      * and ? glob within a path segment (never across /)
//   !pattern      re-include: last matching line wins (gitignore's rule)
//
// The defaults are listed first, so a `.ledgeignore` line like `!build` can
// win a workspace's real build/ folder back. There is no `**`, since a name
// pattern already matches at any depth. Re-including inside an ignored
// directory does not work: the walk prunes it before reading its children.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Directory names skipped by default, at any depth. Exact names only, and
// directories only, so a file called build.md is not mistaken for the build
// directory. The list sticks to the near-universal conventions: anything
// more opinionated belongs in the workspace's own .ledgeignore.
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
  // True when a slash survives stripping `!` and any trailing slash, so
  // `drafts/` is not anchored. Anchored patterns match against the full
  // root-relative path, the rest against the entry name.
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

// One glob pattern to regex source: * and ? match within a path segment,
// the rest is literal. Split on the globs first so it can be escaped whole.
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
  // A leading slash is an explicit anchor, gitignore's spelling. An interior
  // slash anchors too. A path with a slash in it only means something from
  // the root. The check runs before the leading slash is stripped: after the
  // strip, "/scratch" is just "scratch" and matches at any depth.
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
 * The matcher for one workspace root, read fresh on every walk. The read is
 * small next to the directory scan it guards. An edit takes effect at the
 * next refresh, with nothing to reload. A missing file (almost every
 * workspace) means the defaults only. An unusable line is skipped and logged.
 */
export async function loadIgnore(root: string): Promise<IgnoreMatcher> {
  const text = await readFile(join(root, LEDGEIGNORE), "utf8").catch(() => "");
  const matcher = parseIgnore(text);
  for (const p of matcher.problems) console.warn(`[notes] ${LEDGEIGNORE} in ${root}: ${p}`);
  return matcher;
}
