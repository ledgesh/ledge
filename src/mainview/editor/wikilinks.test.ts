// The wikilink CodeMirror seams: what parses as a `[[...]]` node and what the
// `[[` picker offers. (The pure target/resolution decisions are tested with
// their code in shared/wikilinks.test.ts.) Parser assertions run against
// @lezer/markdown directly (livePreview.test.ts's move); completion
// assertions build a real EditorState — still no DOM.
import { describe, expect, test } from "bun:test";
import { GFM, parser } from "@lezer/markdown";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { NoteMeta } from "../../shared/rpc-schema";
import { configureBridge } from "./bridge";
import { wikiCompletionSource, wikiLinkExtension, wikiTargetAt } from "./wikilinks";

const md = parser.configure([GFM, wikiLinkExtension]);

function wikiSpans(text: string): string[] {
  const out: string[] = [];
  md.parse(text).iterate({
    enter(n) {
      if (n.name === "WikiLink") out.push(text.slice(n.from, n.to));
    },
  });
  return out;
}

const note = (title: string, path = `/ws/${title}.md`, mtimeMs = 0): NoteMeta => ({
  path,
  title,
  mtimeMs,
});

describe("wikiLinkExtension", () => {
  test("[[Title]] parses as one WikiLink node", () => {
    expect(wikiSpans("see [[Meeting Notes]] end")).toEqual(["[[Meeting Notes]]"]);
  });

  test("the #heading anchor rides inside the node", () => {
    expect(wikiSpans("see [[Notes#Setup]]")).toEqual(["[[Notes#Setup]]"]);
  });

  test("an empty [[]] stays raw text", () => {
    expect(wikiSpans("type [[]] here")).toEqual([]);
  });

  test("an unclosed [[title never becomes a link", () => {
    expect(wikiSpans("dangling [[half")).toEqual([]);
  });

  test("a newline ends the attempt — wikilinks are single-line", () => {
    expect(wikiSpans("a [[first\nsecond]] b")).toEqual([]);
  });

  test("a nested [ bails out to the ordinary link machinery", () => {
    // `[[a](url)` must still parse as a bracketed markdown link, not half a
    // wikilink swallowing the syntax.
    const text = "x [[a](https://e.com) y";
    expect(wikiSpans(text)).toEqual([]);
    let sawLink = false;
    md.parse(text).iterate({
      enter(n) {
        if (n.name === "Link") sawLink = true;
      },
    });
    expect(sawLink).toBe(true);
  });

  test("a wikilink inside a code fence is code, not a link", () => {
    expect(wikiSpans("```\n[[Not A Link]]\n```")).toEqual([]);
  });
});

describe("wikiTargetAt", () => {
  const text = "see [[Notes#Setup]] end";
  const doc = { sliceString: (from: number, to: number) => text.slice(from, to) };
  const tree = md.parse(text);

  test("returns the span and inner target for a position on the link", () => {
    expect(wikiTargetAt(doc, tree, text.indexOf("Notes"))).toEqual({
      from: 4,
      to: 19,
      target: "Notes#Setup",
    });
  });

  test("either edge of the link counts as on it", () => {
    expect(wikiTargetAt(doc, tree, 4)?.target).toBe("Notes#Setup");
    expect(wikiTargetAt(doc, tree, 19)?.target).toBe("Notes#Setup");
  });

  test("positions off the link return null", () => {
    expect(wikiTargetAt(doc, tree, 0)).toBeNull();
    expect(wikiTargetAt(doc, tree, text.length)).toBeNull();
  });
});

describe("wikiCompletionSource", () => {
  // The bridge is module-global; registering wikiNotes here is the same
  // stubbing-at-the-seam move as the store tests (testing.md §4).
  configureBridge({
    wikiNotes: () => [note("Alpha"), note("Beta"), note("Bad [title]"), note("Has#Hash")],
  });

  function complete(docText: string, pos: number, explicit = false): CompletionResult | null {
    const state = EditorState.create({
      doc: docText,
      extensions: [markdown({ base: markdownLanguage, extensions: [wikiLinkExtension] })],
    });
    ensureSyntaxTree(state, state.doc.length, 1000);
    return wikiCompletionSource(new CompletionContext(state, pos, explicit));
  }

  test("typing [[ offers every linkable note title", () => {
    const r = complete("go [[", 5);
    expect(r?.from).toBe(5);
    expect(r?.options.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
  });

  test("a partial title keeps the completion anchored after the brackets", () => {
    const r = complete("go [[Al", 7);
    expect(r?.from).toBe(5);
  });

  test("titles the grammar cannot express are not offered", () => {
    const labels = complete("go [[", 5)?.options.map((o) => o.label) ?? [];
    expect(labels).not.toContain("Bad [title]");
    expect(labels).not.toContain("Has#Hash");
  });

  test("no [[ before the cursor means no completion", () => {
    expect(complete("plain text", 5)).toBeNull();
  });

  test("inside a code fence the picker stays quiet", () => {
    const text = "```\n[[\n```";
    expect(complete(text, 6)).toBeNull();
  });
});
