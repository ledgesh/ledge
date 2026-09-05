// Nothing in the manual runs (writing.md §10). A fence in a doc page is a live
// button on whichever machine shows the page — this Mac, or a phone's server —
// in `$HOME` with no frontmatter, and the reader cannot see which. So every
// fence whose language Ledge could run must carry `norun` on its opener
// (interactions.md §4e). This is the check that a new page, or a new example
// on an old one, cannot forget it.
import { describe, expect, test } from "bun:test";
import { noRun, parseFenceInfo } from "../mainview/editor/fenceInfo";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { DOC_PAGES } from "./docsContent";

// The defaults, plus `sql`: Running Code shows it as the language to add, and
// a manual whose own example goes live the moment a reader follows that advice
// would be the one fence the rule missed.
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
