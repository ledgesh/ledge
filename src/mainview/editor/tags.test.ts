// The tag CodeMirror seams: what parses as a #tag node, what a gesture at a
// position addresses (tagAt), and what the `#` picker offers. (The pure
// grammar decisions — charset, validity, fence-awareness for the Bun scan —
// are tested with their code in shared/tags.test.ts.) Parser assertions run
// against @lezer/markdown directly; completion assertions build a real
// EditorState — still no DOM (wikilinks.test.ts's moves throughout).
import { describe, expect, test } from "bun:test";
import { GFM, parser } from "@lezer/markdown";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { configureBridge } from "./bridge";
import { hashtagExtension, tagAt, tagCompletionSource } from "./tags";

const md = parser.configure([GFM, hashtagExtension]);

function tagSpans(text: string): string[] {
  const out: string[] = [];
  md.parse(text).iterate({
    enter(n) {
      if (n.name === "HashTag") out.push(text.slice(n.from, n.to));
    },
  });
  return out;
}

describe("hashtagExtension", () => {
  test("a #tag after whitespace parses as one HashTag node", () => {
    expect(tagSpans("note #work here")).toEqual(["#work"]);
    expect(tagSpans("two #work #home")).toEqual(["#work", "#home"]);
  });

  test("a line-start #word is a tag — CommonMark already says it is no heading", () => {
    expect(tagSpans("#work\n")).toEqual(["#work"]);
  });

  test("a real heading is not a tag, but may carry one", () => {
    expect(tagSpans("# Heading")).toEqual([]);
    expect(tagSpans("# Heading with #tag")).toEqual(["#tag"]);
  });

  test("the boundary rule kills glued #s: fragments, ##, mid-word", () => {
    expect(tagSpans("see https://e.com/page#frag")).toEqual([]);
    expect(tagSpans("a ##tag b")).toEqual([]);
    expect(tagSpans("word#tag")).toEqual([]);
    // A markdown marker glues too — the boundary is textual whitespace,
    // matching the shared line scanner exactly.
    expect(tagSpans("**#tag**")).toEqual([]);
  });

  test("the token needs a letter or _, matching isTagToken", () => {
    expect(tagSpans("#123 #2024")).toEqual([]);
    expect(tagSpans("#fff #v2 #project/ledge")).toEqual(["#fff", "#v2", "#project/ledge"]);
  });

  test("a #tag inside a code fence is code — inline parsers never run there", () => {
    expect(tagSpans("```\n#work\n```")).toEqual([]);
  });
});

describe("tagAt", () => {
  const text = "do #work now";
  const doc = { sliceString: (from: number, to: number) => text.slice(from, to) };
  const tree = md.parse(text);

  test("returns the span and bare tag for a position on it", () => {
    expect(tagAt(doc, tree, text.indexOf("work"))).toEqual({ from: 3, to: 8, tag: "work" });
  });

  test("either edge counts as on it", () => {
    expect(tagAt(doc, tree, 3)?.tag).toBe("work");
    expect(tagAt(doc, tree, 8)?.tag).toBe("work");
  });

  test("positions off the tag return null", () => {
    expect(tagAt(doc, tree, 0)).toBeNull();
    expect(tagAt(doc, tree, text.length)).toBeNull();
  });
});

describe("tagCompletionSource", () => {
  // The bridge is module-global; registering workspaceTags here is the same
  // stubbing-at-the-seam move as the wikiNotes stub beside it.
  configureBridge({
    workspaceTags: () => [
      { tag: "work", count: 2 },
      { tag: "project/ledge", count: 1 },
    ],
  });

  function complete(docText: string, pos: number, explicit = false): CompletionResult | null {
    const state = EditorState.create({
      doc: docText,
      extensions: [markdown({ base: markdownLanguage, extensions: [hashtagExtension] })],
    });
    ensureSyntaxTree(state, state.doc.length, 1000);
    return tagCompletionSource(new CompletionContext(state, pos, explicit));
  }

  test("typing # plus a character offers the workspace's tags", () => {
    const r = complete("do #w", 5);
    expect(r?.from).toBe(3);
    expect(r?.options.map((o) => o.label)).toEqual(["#work", "#project/ledge"]);
  });

  test("a bare # pops only on an explicit ask — headings start with # too", () => {
    expect(complete("do #", 4)).toBeNull();
    expect(complete("do #", 4, true)?.options.length).toBe(2);
  });

  test("a glued # is not a tag boundary, so no popup", () => {
    expect(complete("word#w", 6)).toBeNull();
  });

  test("inactive inside code", () => {
    const text = "```\n#w\n```";
    expect(complete(text, text.indexOf("#w") + 2)).toBeNull();
  });

  test("an empty vocabulary means no popup, not an empty one", () => {
    configureBridge({ workspaceTags: () => [] });
    try {
      expect(complete("do #w", 5)).toBeNull();
    } finally {
      configureBridge({
        workspaceTags: () => [
          { tag: "work", count: 2 },
          { tag: "project/ledge", count: 1 },
        ],
      });
    }
  });
});
