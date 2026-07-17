// The ignore grammar, pure (parseIgnore): what the note walk skips beyond
// dot-entries. The walk-level behavior (pruning, .ledgeignore read from disk,
// search inheriting the skips) lives in notes.fs.test.ts.
import { describe, expect, test } from "bun:test";
import { DEFAULT_IGNORED_DIRS, parseIgnore } from "./ignore";

const empty = () => parseIgnore("");

describe("defaults", () => {
  test("well-known vendor/build directory names are ignored at any depth", () => {
    const ig = empty();
    for (const name of DEFAULT_IGNORED_DIRS) {
      expect(ig.ignores(name, true)).toBe(true);
      expect(ig.ignores(`packages/app/${name}`, true)).toBe(true);
    }
  });

  test("directories only: a FILE named like one is not a build system", () => {
    expect(empty().ignores("build", false)).toBe(false);
    expect(empty().ignores("notes/target", false)).toBe(false);
  });

  test("near misses stay visible", () => {
    expect(empty().ignores("node_modules_notes", true)).toBe(false);
    expect(empty().ignores("rebuild", true)).toBe(false);
  });
});

describe("patterns", () => {
  test("a bare name matches files and directories at any depth", () => {
    const ig = parseIgnore("drafts\n");
    expect(ig.ignores("drafts", true)).toBe(true);
    expect(ig.ignores("area/drafts", true)).toBe(true);
    expect(ig.ignores("drafts", false)).toBe(true);
    expect(ig.ignores("drafts-2", true)).toBe(false);
  });

  test("a trailing slash makes it directory-only", () => {
    const ig = parseIgnore("drafts/\n");
    expect(ig.ignores("drafts", true)).toBe(true);
    expect(ig.ignores("drafts", false)).toBe(false);
  });

  test("a slash anchors to the root", () => {
    const ig = parseIgnore("docs/internal\n");
    expect(ig.ignores("docs/internal", true)).toBe(true);
    expect(ig.ignores("elsewhere/docs/internal", true)).toBe(false);
    // The leading-slash spelling means the same thing.
    expect(parseIgnore("/scratch\n").ignores("scratch", true)).toBe(true);
    expect(parseIgnore("/scratch\n").ignores("deep/scratch", true)).toBe(false);
  });

  test("* and ? glob within a segment, never across a slash", () => {
    const ig = parseIgnore("*.wip.md\ntemp-?\n");
    expect(ig.ignores("plan.wip.md", false)).toBe(true);
    expect(ig.ignores("deep/plan.wip.md", false)).toBe(true);
    expect(ig.ignores("temp-1", true)).toBe(true);
    expect(ig.ignores("temp-12", true)).toBe(false);
    // An anchored glob's * cannot swallow a path separator.
    expect(parseIgnore("docs/*.md\n").ignores("docs/a.md", false)).toBe(true);
    expect(parseIgnore("docs/*.md\n").ignores("docs/sub/a.md", false)).toBe(false);
  });

  test("regex metacharacters in names are literal", () => {
    const ig = parseIgnore("notes (old)\n");
    expect(ig.ignores("notes (old)", true)).toBe(true);
    expect(ig.ignores("notes xoldx", true)).toBe(false);
  });

  test("comments and blank lines are skipped", () => {
    const ig = parseIgnore("# junk\n\n  \ndrafts\n");
    expect(ig.ignores("drafts", true)).toBe(true);
    expect(ig.ignores("# junk", true)).toBe(false);
    expect(ig.problems).toEqual([]);
  });

  test("a bare ! or / is unusable and costs only itself", () => {
    const ig = parseIgnore("!\n/\ndrafts\n");
    expect(ig.problems).toHaveLength(2);
    expect(ig.ignores("drafts", true)).toBe(true);
  });
});

describe("negation", () => {
  test("!name wins a default back — the reason the defaults are listed first", () => {
    const ig = parseIgnore("!build\n");
    expect(ig.ignores("build", true)).toBe(false);
    expect(ig.ignores("node_modules", true)).toBe(true); // untouched
  });

  test("last matching line wins, in either direction", () => {
    const ig = parseIgnore("drafts\n!drafts\n");
    expect(ig.ignores("drafts", true)).toBe(false);
    const ig2 = parseIgnore("!drafts\ndrafts\n");
    expect(ig2.ignores("drafts", true)).toBe(true);
  });
});
