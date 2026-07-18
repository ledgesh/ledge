// The pure wikilink decisions: how a target splits into title + heading,
// which note a title resolves to, and what a backlink scan counts as a link.
// (The `[[...]]` grammar and the picker are CodeMirror seams, tested in
// mainview/editor/wikilinks.test.ts.)
import { describe, expect, test } from "bun:test";
import { appendToNote, headingsOf, parseWikiTarget, resolveWikiTitle, wikiRefsOf } from "./wikilinks";

const note = (title: string, path = `/ws/${title}.md`) => ({ path, title });

describe("parseWikiTarget", () => {
  test("a bare title has no heading", () => {
    expect(parseWikiTarget("Meeting Notes")).toEqual({ title: "Meeting Notes", heading: null });
  });

  test("the first # splits title from heading, both trimmed", () => {
    expect(parseWikiTarget(" Notes # Setup ")).toEqual({ title: "Notes", heading: "Setup" });
  });

  test("a heading may itself contain # (only the first splits)", () => {
    expect(parseWikiTarget("Notes#a#b")).toEqual({ title: "Notes", heading: "a#b" });
  });

  test("a trailing bare # is no heading", () => {
    expect(parseWikiTarget("Notes#")).toEqual({ title: "Notes", heading: null });
  });

  test("no title means no target — [[#h]] and whitespace are dangling by construction", () => {
    expect(parseWikiTarget("#Setup")).toBeNull();
    expect(parseWikiTarget("   ")).toBeNull();
  });
});

describe("resolveWikiTitle", () => {
  const notes = [note("Alpha"), note("beta"), note("Beta", "/ws/Beta-2.md")];

  test("exact title match wins", () => {
    expect(resolveWikiTitle("Alpha", notes)?.path).toBe("/ws/Alpha.md");
  });

  test("matching is case-insensitive, but an exact-case hit beats a folded one", () => {
    expect(resolveWikiTitle("BETA", notes)?.path).toBe("/ws/beta.md");
    expect(resolveWikiTitle("Beta", notes)?.path).toBe("/ws/Beta-2.md");
  });

  test("no fuzz: a near-miss is dangling, never the nearest note", () => {
    expect(resolveWikiTitle("Alphas", notes)).toBeNull();
  });

  test("titles compare trimmed on both sides", () => {
    expect(resolveWikiTitle("  alpha  ", notes)?.path).toBe("/ws/Alpha.md");
  });
});

describe("wikiRefsOf", () => {
  test("finds every link with its 1-based line and the match as written", () => {
    expect(wikiRefsOf("a [[One]] b\nplain\nsee [[Two#Setup]] and [[Three]]")).toEqual([
      { title: "One", heading: null, line: 1, raw: "[[One]]" },
      { title: "Two", heading: "Setup", line: 3, raw: "[[Two#Setup]]" },
      { title: "Three", heading: null, line: 3, raw: "[[Three]]" },
    ]);
  });

  test("raw keeps the file's own spelling, not the parsed normalization", () => {
    // The title trims and the empty heading drops, but `raw` must stay what a
    // reveal can re-find in the line verbatim.
    expect(wikiRefsOf("x [[ Spaced #]] y")).toEqual([
      { title: "Spaced", heading: null, line: 1, raw: "[[ Spaced #]]" },
    ]);
  });

  test("mirrors the grammar's refusals: empty, bracketed, and multi-line stay raw", () => {
    expect(wikiRefsOf("x [[]] y")).toEqual([]);
    expect(wikiRefsOf("x [[a](url) y")).toEqual([]);
    expect(wikiRefsOf("a [[first\nsecond]] b")).toEqual([]);
    expect(wikiRefsOf("a [[half] b]]")).toEqual([]);
  });

  test("a dangling-by-construction target ([[#h]]) is not a ref", () => {
    expect(wikiRefsOf("x [[#Setup]] y")).toEqual([]);
  });

  test("fenced code is not scanned — pasted logs are not links", () => {
    expect(wikiRefsOf("```\n[[Not A Link]]\n```\n[[Real]]")).toEqual([
      { title: "Real", heading: null, line: 4, raw: "[[Real]]" },
    ]);
  });

  test("a fence closes only on its own character and length", () => {
    // The ~~~ line inside a ``` fence is content, and a shorter ```` closer
    // does not close a ````` fence.
    expect(wikiRefsOf("```\n~~~\n[[A]]\n```\n[[B]]")).toEqual([{ title: "B", heading: null, line: 5, raw: "[[B]]" }]);
    expect(wikiRefsOf("`````\n```\n[[A]]\n`````\n[[B]]")).toEqual([{ title: "B", heading: null, line: 5, raw: "[[B]]" }]);
  });

  test("an unclosed fence swallows the rest of the note", () => {
    expect(wikiRefsOf("```\n[[A]]")).toEqual([]);
  });
});

describe("headingsOf", () => {
  test("finds ATX headings with their levels and lines; fences hide theirs", () => {
    const text = "# Top\n\nbody\n\n## Sub One ##\n\n```\n# fenced comment\n```\n\n## Sub Two\n";
    expect(headingsOf(text)).toEqual([
      { text: "Top", level: 1, line: 1 },
      { text: "Sub One", level: 2, line: 5 },
      { text: "Sub Two", level: 2, line: 11 },
    ]);
  });

  test("a #hashtag without a space is not a heading", () => {
    expect(headingsOf("#nope\n#### yes\n")).toEqual([{ text: "yes", level: 4, line: 2 }]);
  });
});

// The splice behind append_note. Every case asserts the full result text:
// block spacing IS the behavior here.
describe("appendToNote", () => {
  const NOTE = "# Jokes\n\n## Puns\n\nfirst pun\n\n## Long Ones\n\na long joke\n";

  test("no heading appends at the end of the note", () => {
    expect(appendToNote("# Log\n\nfirst entry\n\n\n", "second entry")).toBe(
      "# Log\n\nfirst entry\n\nsecond entry\n",
    );
  });

  test("a heading lands at the end of its section, before the next heading", () => {
    expect(appendToNote(NOTE, "second pun", "Puns")).toBe(
      "# Jokes\n\n## Puns\n\nfirst pun\n\nsecond pun\n\n## Long Ones\n\na long joke\n",
    );
  });

  test("the last section appends to the end of the note", () => {
    expect(appendToNote(NOTE, "another", "Long Ones")).toBe(
      "# Jokes\n\n## Puns\n\nfirst pun\n\n## Long Ones\n\na long joke\n\nanother\n",
    );
  });

  test("a shallow heading's section spans its subsections", () => {
    // Appending under the H1 lands after everything: there is no later
    // heading at level <= 1 to stop at.
    expect(appendToNote(NOTE, "a closing line", "Jokes")).toBe(NOTE + "\na closing line\n");
  });

  test("matches case-insensitively; first match wins", () => {
    const dup = "## A\n\none\n\n## a\n\ntwo\n";
    expect(appendToNote(dup, "x", "a")).toBe("## A\n\none\n\nx\n\n## a\n\ntwo\n");
  });

  test("an empty section gets its first content", () => {
    expect(appendToNote("## Todo\n\n## Done\n", "- [ ] item", "Todo")).toBe(
      "## Todo\n\n- [ ] item\n\n## Done\n",
    );
  });

  test("a run of trailing blanks in the section collapses to one separator", () => {
    expect(appendToNote("## A\n\nbody\n\n\n\n## B\n", "more", "A")).toBe("## A\n\nbody\n\nmore\n\n## B\n");
  });

  test("a fenced fake heading is neither a target nor a boundary", () => {
    const fenced = "## Real\n\n```\n## Fake\n```\n\ntail\n";
    expect(appendToNote(fenced, "x", "Fake")).toBeNull();
    // Appending under Real crosses the fence: the section runs to EOF.
    expect(appendToNote(fenced, "x", "Real")).toBe("## Real\n\n```\n## Fake\n```\n\ntail\n\nx\n");
  });

  test("a missing heading is null, and a file without a trailing newline gains one", () => {
    expect(appendToNote(NOTE, "x", "Nope")).toBeNull();
    expect(appendToNote("## A\nbody", "x", "A")).toBe("## A\nbody\n\nx\n");
  });

  // The trailing-prompt-block rule: a runnable ```prompt fence at the end is
  // the note's control, and additions accumulate ABOVE it — the exact "add a
  // joke to this note" note, where the block would otherwise wedge every
  // result between itself and the content.
  test("an end-append lands above a trailing prompt block", () => {
    const note = "# Jokes\n\n> joke one\n\n```prompt\nadd another joke\n```\n";
    expect(appendToNote(note, "> joke two")).toBe(
      "# Jokes\n\n> joke one\n\n> joke two\n\n```prompt\nadd another joke\n```\n",
    );
  });

  test("a section-append respects a prompt block at its section's end", () => {
    const note = "## Puns\n\nfirst\n\n```prompt\nmore puns\n```\n\n## Long Ones\n\nsaga\n";
    expect(appendToNote(note, "second", "Puns")).toBe(
      "## Puns\n\nfirst\n\nsecond\n\n```prompt\nmore puns\n```\n\n## Long Ones\n\nsaga\n",
    );
  });

  test("an unclosed trailing prompt fence floats too — it swallows to EOF, like the editor", () => {
    expect(appendToNote("content\n\n```prompt\nstill typing", "added")).toBe(
      "content\n\nadded\n\n```prompt\nstill typing\n",
    );
  });

  test("a whole run of trailing prompt blocks floats as one", () => {
    const note = "body\n\n```prompt\na\n```\n\n```prompt\nb\n```\n";
    expect(appendToNote(note, "new")).toBe("body\n\nnew\n\n```prompt\na\n```\n\n```prompt\nb\n```\n");
  });

  test("a note that IS just a prompt block gets its content above it, no leading blank", () => {
    expect(appendToNote("```prompt\ngo\n```\n", "result")).toBe("result\n\n```prompt\ngo\n```\n");
  });

  test("other trailing fences are content: a ```sh block does not float", () => {
    const note = "notes\n\n```sh\nls\n```\n";
    expect(appendToNote(note, "more")).toBe("notes\n\n```sh\nls\n```\n\nmore\n");
  });

  test("a prompt block in the middle is untouched — only the trailing run floats", () => {
    const note = "```prompt\ntop\n```\n\nbody\n";
    expect(appendToNote(note, "tail")).toBe("```prompt\ntop\n```\n\nbody\n\ntail\n");
  });
});
