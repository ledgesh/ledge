// The concealment core, tested against @lezer/markdown directly (the same
// grammar family the editor's lang-markdown uses) so no DOM or editor is
// involved. Most assertions go through `visible`, which applies the hide
// spans to the source text — asserting on what the reader would see keeps the
// tests independent of exactly how the parser slices its mark nodes.
import { describe, expect, test } from "bun:test";
import { GFM, parser } from "@lezer/markdown";
import { blockRevealed, concealments, linkAt, linkTargetAt, type Conceal, type Span } from "./livePreview";
import { wikiLinkExtension } from "./wikilinks";
import { hashtagExtension } from "./tags";

// GFM plus the wikilink and hashtag grammars — the same set the editor's
// parser carries (editor/setup.ts), so the core is tested against the tree
// it will see.
const md = parser.configure([GFM, wikiLinkExtension, hashtagExtension]);

const doc = (text: string) => ({
  sliceString: (from: number, to: number) => text.slice(from, to),
});

// Caret at 0 by default: every fixture puts its subject past an "x\n\n"
// prefix, so the default selection touches nothing under test.
function conceal(text: string, sel: Span[] = [{ from: 0, to: 0 }], exclude: Span | null = null): Conceal[] {
  return concealments(doc(text), md.parse(text), sel, exclude);
}

function visible(text: string, sel?: Span[], exclude?: Span | null): string {
  let out = "";
  let pos = 0;
  for (const c of conceal(text, sel, exclude)) {
    if (c.kind !== "hide") continue;
    out += text.slice(pos, c.from);
    pos = Math.max(pos, c.to);
  }
  return out + text.slice(pos);
}

function links(text: string, sel?: Span[]): Array<{ text: string; url: string | null }> {
  return conceal(text, sel)
    .filter((c): c is Span & { kind: "link"; url: string | null } => c.kind === "link")
    .map((c) => ({ text: text.slice(c.from, c.to), url: c.url }));
}

function tags_(text: string, sel?: Span[], exclude?: Span | null): Array<{ text: string; tag: string }> {
  return conceal(text, sel, exclude)
    .filter((c): c is Span & { kind: "tag"; tag: string } => c.kind === "tag")
    .map((c) => ({ text: text.slice(c.from, c.to), tag: c.tag }));
}

describe("concealments", () => {
  test("emphasis, strong, strikethrough and inline-code marks hide", () => {
    expect(visible("x\n\n**bold** *it* ~~gone~~ `code`")).toBe("x\n\nbold it gone code");
  });

  test("a selection touching the element reveals it, endpoints inclusive", () => {
    const text = "x\n\n**bold**";
    // Caret on the element's leading edge counts as inside it.
    expect(visible(text, [{ from: 3, to: 3 }])).toBe(text);
    expect(visible(text, [{ from: 6, to: 6 }])).toBe(text);
    // ...but a caret elsewhere on the line does not.
    expect(visible(text, [{ from: 2, to: 2 }])).toBe("x\n\nbold");
  });

  test("any of several selection ranges reveals its own element", () => {
    const text = "x\n\n**a** and **b**";
    expect(visible(text, [{ from: 5, to: 5 }])).toBe("x\n\n**a** and b");
  });

  test("ATX heading marks hide with their separator space", () => {
    expect(visible("x\n\n# Hi")).toBe("x\n\nHi");
    expect(visible("x\n\n### Deep")).toBe("x\n\nDeep");
  });

  test("closing ATX marks hide with the space before them", () => {
    expect(visible("x\n\n## Hi ##")).toBe("x\n\nHi");
  });

  test("a caret anywhere on the heading line reveals its marks", () => {
    expect(visible("x\n\n# Hi", [{ from: 7, to: 7 }])).toBe("x\n\n# Hi");
  });

  test("setext underlines stay visible — a concealed one is just a blank line", () => {
    expect(visible("Title\n=====\n\nx")).toBe("Title\n=====\n\nx");
  });

  test("an inline link conceals to its text, carrying the approved URL", () => {
    expect(visible("x\n\nsee [Ledge](https://example.com) end")).toBe("x\n\nsee Ledge end");
    expect(links("x\n\nsee [Ledge](https://example.com) end")).toEqual([
      { text: "Ledge", url: "https://example.com" },
    ]);
  });

  test("a link title is syntax too", () => {
    expect(visible('x\n\n[a](https://b.co "tip")')).toBe("x\n\na");
  });

  test("a wikilink conceals its brackets and keeps the target, carried raw", () => {
    expect(visible("x\n\nsee [[Meeting Notes]] end")).toBe("x\n\nsee Meeting Notes end");
    const spans = conceal("x\n\nsee [[Meeting Notes#Setup]] end").filter((c) => c.kind === "wikilink");
    expect(spans).toEqual([
      { kind: "wikilink", from: 9, to: 28, target: "Meeting Notes#Setup" },
    ]);
  });

  test("a selection touching a wikilink reveals its raw syntax", () => {
    const text = "x\n\n[[Notes]]";
    expect(visible(text, [{ from: 5, to: 5 }])).toBe(text);
    expect(conceal(text, [{ from: 5, to: 5 }]).filter((c) => c.kind === "wikilink")).toEqual([]);
  });

  test("an empty [[]] is not a wikilink — ordinary link parsing takes it back", () => {
    expect(conceal("x\n\ntype [[]] here").filter((c) => c.kind === "wikilink")).toEqual([]);
  });

  test("an unopenable target still conceals but promises no click", () => {
    expect(visible("x\n\n[notes](./other.md)")).toBe("x\n\nnotes");
    expect(links("x\n\n[notes](./other.md)")).toEqual([{ text: "notes", url: null }]);
  });

  test("an image conceals to its alt text", () => {
    expect(visible("x\n\n![alt text](https://a.com/i.png)")).toBe("x\n\nalt text");
  });

  test("an autolink sheds its angle brackets and keeps the URL as text", () => {
    expect(visible("x\n\n<https://a.com>")).toBe("x\n\nhttps://a.com");
    expect(links("x\n\n<https://a.com>")).toEqual([{ text: "https://a.com", url: "https://a.com" }]);
  });

  test("a bare URL in prose hides nothing but is a link", () => {
    expect(visible("x\n\ngo to https://a.com now")).toBe("x\n\ngo to https://a.com now");
    expect(links("x\n\ngo to https://a.com now")).toEqual([
      { text: "https://a.com", url: "https://a.com" },
    ]);
  });

  test("a caret inside the link text reveals the whole link", () => {
    const text = "x\n\n[ab](https://c.co)";
    expect(visible(text, [{ from: 5, to: 5 }])).toBe(text);
  });

  test("fence marks hide; the info string and every content byte stay", () => {
    expect(visible("x\n\n```sh\nls -la\n```")).toBe("x\n\nsh\nls -la\n");
  });

  test("fence content is never concealed, whatever it contains", () => {
    expect(visible("x\n\n```js\nconst a = `**not md**`\n```")).toBe(
      "x\n\njs\nconst a = `**not md**`\n",
    );
  });

  test("a caret inside the block reveals both fences", () => {
    const text = "x\n\n```sh\nls\n```";
    expect(visible(text, [{ from: 10, to: 10 }])).toBe(text);
  });

  test("nested emphasis inside a concealed link conceals its own marks too", () => {
    expect(visible("x\n\n[**b**](https://c.co)")).toBe("x\n\nb");
  });

  test("a task marker conceals to a checkbox, carrying its checked state", () => {
    const out = conceal("x\n\n- [ ] open\n- [x] shut");
    const tasks = out.filter((c) => c.kind === "task");
    expect(tasks).toEqual([
      { kind: "task", from: 5, to: 8, checked: false },
      { kind: "task", from: 16, to: 19, checked: true },
    ]);
    // The bullet hides with it — the checkbox IS the bullet. The label is
    // untouched (the marker is widget-replaced, never text-hidden).
    expect(out.filter((c) => c.kind === "hide")).toEqual([
      { kind: "hide", from: 3, to: 5 },
      { kind: "hide", from: 14, to: 16 },
    ]);
  });

  test("an ordered task keeps its number — only bullet marks hide", () => {
    const out = conceal("x\n\n1. [ ] first");
    expect(out.filter((c) => c.kind === "task")).toHaveLength(1);
    expect(out.filter((c) => c.kind === "hide")).toEqual([]);
  });

  test("a caret at the task line's start reveals bullet and marker together", () => {
    const out = conceal("x\n\n- [ ] open", [{ from: 3, to: 3 }]);
    expect(out.filter((c) => c.kind === "task")).toEqual([]);
    expect(out.filter((c) => c.kind === "hide")).toEqual([]);
  });

  test("a plain bullet is not a task and keeps its mark", () => {
    expect(visible("x\n\n- just a list item")).toBe("x\n\n- just a list item");
  });

  test("a checked task's label is marked done, concealed or not", () => {
    const concealed = conceal("x\n\n- [x] shut");
    expect(concealed.filter((c) => c.kind === "done")).toEqual([{ kind: "done", from: 8, to: 13 }]);
    // Caret on the marker reveals the raw [x] but the label stays done.
    const revealedOut = conceal("x\n\n- [x] shut", [{ from: 6, to: 6 }]);
    expect(revealedOut.filter((c) => c.kind === "task")).toEqual([]);
    expect(revealedOut.filter((c) => c.kind === "done")).toEqual([{ kind: "done", from: 8, to: 13 }]);
  });

  test("a caret in the task's label does NOT reveal the marker", () => {
    const out = conceal("x\n\n- [ ] open", [{ from: 11, to: 11 }]);
    expect(out.filter((c) => c.kind === "task")).toHaveLength(1);
  });

  test("a thematic break conceals to a rule, and reveals under the caret", () => {
    const text = "x\n\n---\n\ny";
    expect(conceal(text).filter((c) => c.kind === "rule")).toEqual([{ kind: "rule", from: 3, to: 6 }]);
    expect(conceal(text, [{ from: 4, to: 4 }]).filter((c) => c.kind === "rule")).toEqual([]);
  });

  test("an escape's backslash hides; the escaped character stays", () => {
    expect(visible("x\n\nnot \\*bold\\*")).toBe("x\n\nnot *bold*");
    expect(visible("x\n\nnot \\*bold\\*", [{ from: 8, to: 8 }])).toBe("x\n\nnot \\*bold*");
  });

  test("a backslash hard break hides its backslash; the spaces form is left alone", () => {
    expect(visible("x\n\na\\\nb")).toBe("x\n\na\nb");
    expect(visible("x\n\na  \nb")).toBe("x\n\na  \nb");
  });

  test("a decodable entity conceals to its character; an unknown one stays raw", () => {
    const out = conceal("x\n\nAT&amp;T and &bogus; and &#96;");
    expect(out.filter((c) => c.kind === "entity")).toEqual([
      { kind: "entity", from: 5, to: 10, text: "&" },
      { kind: "entity", from: 28, to: 33, text: "`" },
    ]);
  });

  test("the excluded region (frontmatter) stays raw wholesale", () => {
    const text = "# A\n\n# B";
    expect(visible(text, [{ from: 4, to: 4 }], { from: 0, to: 3 })).toBe("# A\n\nB");
  });

  test("an inline #tag hides nothing but is marked, carrying its bare text", () => {
    const text = "x\n\ndo #work now";
    expect(visible(text)).toBe(text);
    expect(tags_(text)).toEqual([{ text: "#work", tag: "work" }]);
  });

  test("a #tag is emitted even under the caret — the bare-URL stance", () => {
    // Touched-vs-not is a draw-time decision (plain mark vs armed one);
    // the core reports the tag either way so the styling never blinks.
    const text = "x\n\ndo #work now";
    expect(tags_(text, [{ from: 5, to: 5 }])).toEqual([{ text: "#work", tag: "work" }]);
  });

  test("a #tag in the excluded region (frontmatter) is not emitted", () => {
    const text = "tags: x\n\ndo #work now";
    expect(tags_(text, undefined, { from: 0, to: 7 })).toEqual([{ text: "#work", tag: "work" }]);
    expect(tags_("tags: #x\n\nplain", undefined, { from: 0, to: 8 })).toEqual([]);
  });
});

describe("linkTargetAt", () => {
  function target(text: string, pos: number): string | null {
    return linkTargetAt(doc(text), md.parse(text), pos);
  }

  test("resolves from anywhere inside an inline link, edges included", () => {
    const text = "x\n\n[ab](https://c.co) tail";
    for (const pos of [3, 5, 10, 21]) expect(target(text, pos)).toBe("https://c.co");
    expect(target(text, 23)).toBeNull();
  });

  test("resolves bare URLs and autolinks", () => {
    expect(target("x\n\nhttps://a.com", 8)).toBe("https://a.com");
    expect(target("x\n\n<https://a.com>", 8)).toBe("https://a.com");
  });

  test("plain prose is not a link", () => {
    expect(target("just words here", 5)).toBeNull();
  });

  test("a disallowed scheme resolves to nothing — the click must not fire", () => {
    expect(target("x\n\n[a](javascript:alert(1))", 4)).toBeNull();
  });

  test("linkAt carries the element's span — the reveal unit click gating checks", () => {
    const text = "x\n\n[ab](https://c.co) tail";
    expect(linkAt(doc(text), md.parse(text), 5)).toEqual({
      from: text.indexOf("["),
      to: text.indexOf(")") + 1,
      url: "https://c.co",
    });
    const bare = "x\n\ngo to https://a.com now";
    expect(linkAt(doc(bare), md.parse(bare), 12)).toEqual({
      from: bare.indexOf("https"),
      to: bare.indexOf(" now"),
      url: "https://a.com",
    });
  });
});

describe("blockRevealed", () => {
  // The block (an image line, a table) occupies [10, 20].
  const block = { from: 10, to: 20 };
  const range = (anchor: number, head: number) => ({
    anchor,
    head,
    from: Math.min(anchor, head),
    to: Math.max(anchor, head),
  });

  test("a caret on the block reveals it, endpoints included", () => {
    expect(blockRevealed(block, [range(15, 15)])).toBe(true);
    expect(blockRevealed(block, [range(10, 10)])).toBe(true);
    expect(blockRevealed(block, [range(20, 20)])).toBe(true);
  });

  test("a caret off the block leaves it drawn", () => {
    expect(blockRevealed(block, [range(9, 9)])).toBe(false);
    expect(blockRevealed(block, [range(21, 21)])).toBe(false);
  });

  // The bug this rule exists for: a selection dragged past a block must not
  // change its face, in either direction, or the reflow moves the text out
  // from under the pointer and the block flaps.
  test("a selection sweeping across the block from below leaves it drawn", () => {
    expect(blockRevealed(block, [range(40, 15)])).toBe(false);
    expect(blockRevealed(block, [range(40, 5)])).toBe(false);
  });

  test("a selection sweeping across the block from above leaves it drawn", () => {
    expect(blockRevealed(block, [range(0, 15)])).toBe(false);
    expect(blockRevealed(block, [range(0, 40)])).toBe(false);
  });

  test("a selection started ON the block keeps it revealed as it grows off", () => {
    expect(blockRevealed(block, [range(12, 12)])).toBe(true);
    expect(blockRevealed(block, [range(12, 18)])).toBe(true);
    expect(blockRevealed(block, [range(12, 40)])).toBe(true);
    expect(blockRevealed(block, [range(12, 0)])).toBe(true);
  });

  test("any one of several cursors anchored on the block reveals it", () => {
    expect(blockRevealed(block, [range(0, 2), range(15, 15)])).toBe(true);
    expect(blockRevealed(block, [range(0, 2), range(30, 32)])).toBe(false);
  });
});
