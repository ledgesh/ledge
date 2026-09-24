// Nothing in the manual runs (writing.md §10). A fence in a doc page would be
// a live button on whichever machine shows the page, this Mac or a phone's
// server, and the reader cannot see which. Its shell would start in `$HOME`,
// since a manual page carries no frontmatter to say otherwise. So every fence
// in a runnable language carries `norun` on its opener (interactions.md §4e).
// This test fails a page that leaves one unmarked, a new page or a new
// example on an old one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { respellChords } from "../mainview/commands/format";
import { configureModKey } from "../mainview/commands/modKey";
import { noRun, parseFenceInfo } from "../mainview/editor/fenceInfo";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { DOC_PAGES } from "./docsContent";

// RUNNABLE is the runnable defaults plus `sql`, which is not one of them.
// Running Code tells the reader to add `sql` to `runnable`. For a reader who
// does, that page's own `sql` example would go live, so the example carries
// `norun` and this test checks `sql` fences too.
const RUNNABLE = new Set([...DEFAULT_SETTINGS.blocks.runnable, "sql"].map((l) => l.toLowerCase()));

// Top-level fence openers only. A fence inside a ```` quoting block is body
// text to Lezer and never draws a button, so it is left alone here too.
function topLevelOpeners(text: string): { line: number; info: string }[] {
  const out: { line: number; info: string }[] = [];
  let open: string | null = null;
  text.split("\n").forEach((raw, i) => {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (!m) return;
    const [, marks, info] = m as unknown as [string, string, string];
    if (open === null) {
      open = marks;
      out.push({ line: i + 1, info: raw });
    } else if (marks[0] === open[0] && marks.length >= open.length && info.trim() === "") {
      open = null;
    }
  });
  return out;
}

describe("the manual's fences", () => {
  test("every fence in a runnable language is marked norun", () => {
    const live: string[] = [];
    for (const page of DOC_PAGES) {
      for (const { line, info } of topLevelOpeners(page.text)) {
        const parsed = parseFenceInfo(info);
        if (parsed.lang && RUNNABLE.has(parsed.lang.toLowerCase()) && !noRun(parsed.attrs)) {
          live.push(`${page.name}:${line}: ${info.trim()}`);
        }
      }
    }
    expect(live).toEqual([]);
  });

  test("the walker sees through a quoting block", () => {
    // The inner ```sh is body text of the ```` block, not an opener.
    const text = "````\n```sh\nnpm install\n```\n````\n\n```sh\npwd\n```\n";
    expect(topLevelOpeners(text).map((o) => o.line)).toEqual([1, 7]);
  });
});

// A Ctrl desktop reads the manual through respellChords (writing.md §10), so
// every glyph chord in it has to be one that function reads: a glyph it
// leaves behind is a chord spelled some way the respelling does not know, or
// a system chord written as glyphs where a menu path belongs.
describe("the manual's chords", () => {
  beforeEach(() => configureModKey("Ctrl"));
  afterEach(() => configureModKey("Meta"));

  test("every one respells for a Ctrl desktop", () => {
    const left: string[] = [];
    for (const page of DOC_PAGES) {
      respellChords(page.text)
        .split("\n")
        .forEach((line, i) => {
          if (/[⌃⌥⇧⌘]/.test(line)) left.push(`${page.name}:${i + 1}: ${line}`);
        });
    }
    expect(left).toEqual([]);
  });
});
