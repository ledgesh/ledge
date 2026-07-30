import { describe, expect, test } from "bun:test";
import {
  blockPasteInsert,
  hasFormatting,
  markdownFromNode,
  richPasteMarkdown,
  type PasteNode,
} from "./htmlPaste";

// The pure core takes a node tree, not HTML — DOMParser builds the real one
// (testing.md §2: no fake browser in this repo), so trees here are hand-built.
// `el`/`t` keep them readable enough to state a rule per test.
const el = (tag: string, attrs: Record<string, string>, ...children: PasteNode[]): PasteNode => ({
  tag,
  attrs,
  children,
});
const t = (text: string): PasteNode => ({ text });
const body = (...children: PasteNode[]): PasteNode => el("body", {}, ...children);
const md = (...children: PasteNode[]): string => markdownFromNode(body(...children));

describe("blocks", () => {
  test("a heading becomes its ATX form at the same level", () => {
    expect(md(el("h3", {}, t("Webhooks")))).toBe("### Webhooks");
  });

  test("an empty heading is not a heading at all", () => {
    expect(md(el("h1", {}, t("  ")), el("p", {}, t("x")))).toBe("x");
  });

  test("paragraphs are separated by a blank line", () => {
    expect(md(el("p", {}, t("one")), el("p", {}, t("two")))).toBe("one\n\ntwo");
  });

  test("a stack of divs is a stack of LINES, not double-spaced paragraphs", () => {
    expect(md(el("div", {}, t("one")), el("div", {}, t("two")), el("div", {}, t("three")))).toBe(
      "one\ntwo\nthree",
    );
  });

  test("a div after a real paragraph still gets the blank line a paragraph earned", () => {
    expect(md(el("p", {}, t("para")), el("div", {}, t("line")))).toBe("para\n\nline");
  });

  test("whitespace between elements is not a paragraph", () => {
    expect(md(t("\n  "), el("p", {}, t("x")), t("\n"))).toBe("x");
  });

  test("br is a line break inside the paragraph it sits in", () => {
    expect(md(el("p", {}, t("one"), el("br", {}), t("two")))).toBe("one\ntwo");
  });

  test("hr is a thematic break", () => {
    expect(md(el("p", {}, t("a")), el("hr", {}), el("p", {}, t("b")))).toBe("a\n\n---\n\nb");
  });

  test("a script's text never reaches the note", () => {
    expect(md(el("p", {}, t("keep")), el("script", {}, t("alert(1)")))).toBe("keep");
  });
});

describe("inline marks", () => {
  test("strong and em become the trio's own markers", () => {
    expect(md(el("p", {}, el("strong", {}, t("bold")), t(" and "), el("em", {}, t("it"))))).toBe(
      "**bold** and *it*",
    );
  });

  test("strikethrough becomes the GFM pair", () => {
    expect(md(el("p", {}, el("s", {}, t("gone"))))).toBe("~~gone~~");
  });

  test("a mark nested inside the same mark emits one pair, not two", () => {
    expect(md(el("p", {}, el("b", {}, el("strong", {}, t("once")))))).toBe("**once**");
  });

  test("bold spelled as a style declaration counts — Google Docs ships no <b>", () => {
    expect(md(el("p", {}, el("span", { style: "font-weight: 700" }, t("bold"))))).toBe("**bold**");
  });

  test("a normal font-weight is not emphasis", () => {
    expect(md(el("p", {}, el("span", { style: "font-weight: 400" }, t("plain"))))).toBe("plain");
  });

  test("padding moves outside the markers, which cannot close against a space", () => {
    expect(md(el("p", {}, t("a"), el("b", {}, t(" x ")), t("b")))).toBe("a **x** b");
  });

  test("a mark wrapping only space keeps the space and drops the markers", () => {
    expect(md(el("p", {}, t("a"), el("b", {}, t(" ")), t("b")))).toBe("a b");
  });

  test("a span with nothing to say is transparent", () => {
    expect(md(el("p", {}, el("span", { class: "x" }, t("just text"))))).toBe("just text");
  });
});

describe("links and images", () => {
  test("a link becomes label and destination", () => {
    expect(md(el("p", {}, el("a", { href: "https://x.dev/a" }, t("docs"))))).toBe(
      "[docs](https://x.dev/a)",
    );
  });

  test("a link whose label is its own URL stays bare", () => {
    expect(md(el("p", {}, el("a", { href: "https://x.dev" }, t("https://x.dev"))))).toBe("https://x.dev");
  });

  test("a mailto link labelled with the address keeps just the address", () => {
    expect(md(el("p", {}, el("a", { href: "mailto:a@b.co" }, t("a@b.co"))))).toBe("a@b.co");
  });

  test("an in-page anchor is not a link once the page is gone", () => {
    expect(md(el("p", {}, el("a", { href: "#sec-2" }, t("see below"))))).toBe("see below");
  });

  test("a scripted link keeps its label and loses the script", () => {
    expect(md(el("p", {}, el("a", { href: "javascript:evil()" }, t("click"))))).toBe("click");
  });

  test("a destination with spaces is bracketed so it does not end early", () => {
    expect(md(el("p", {}, el("a", { href: "https://x.dev/a b" }, t("l"))))).toBe(
      "[l](<https://x.dev/a b>)",
    );
  });

  test("a remote image keeps its alt and src", () => {
    expect(md(el("p", {}, el("img", { src: "https://x.dev/a.png", alt: "chart" })))).toBe(
      "![chart](https://x.dev/a.png)",
    );
  });

  test("an image the note could never resolve degrades to its alt text", () => {
    expect(md(el("p", {}, el("img", { src: "data:image/png;base64,AAA", alt: "logo" })))).toBe("logo");
  });

  test("a 1x1 image is a tracking pixel, not content", () => {
    expect(md(el("p", {}, el("img", { src: "https://x.dev/p.gif", width: "1", height: "1" })))).toBe("");
  });
});

describe("code", () => {
  test("inline code becomes a code span", () => {
    expect(md(el("p", {}, t("run "), el("code", {}, t("ls -l"))))).toBe("run `ls -l`");
  });

  test("a code span containing a backtick is fenced longer and padded", () => {
    expect(md(el("p", {}, el("code", {}, t("`x`"))))).toBe("`` `x` ``");
  });

  test("markdown inside code is never escaped — the backticks already hold it", () => {
    expect(md(el("p", {}, el("code", {}, t("a*b*c"))))).toBe("`a*b*c`");
  });

  test("pre becomes a fence, labelled from the highlighter's class", () => {
    expect(md(el("pre", {}, el("code", { class: "language-ts" }, t("const a = 1\n"))))).toBe(
      "```ts\nconst a = 1\n```",
    );
  });

  test("a pre built one div per line keeps its lines", () => {
    expect(md(el("pre", {}, el("div", {}, t("one")), el("div", {}, t("two"))))).toBe(
      "```\none\ntwo\n```",
    );
  });

  test("a fence in the body is held by a longer fence", () => {
    expect(md(el("pre", {}, t("```\nx\n```")))).toBe("````\n```\nx\n```\n````");
  });
});

describe("lists", () => {
  test("a bulleted list becomes tight dash items", () => {
    expect(md(el("ul", {}, el("li", {}, t("one")), el("li", {}, t("two"))))).toBe("- one\n- two");
  });

  test("an ordered list numbers from its start attribute", () => {
    expect(md(el("ol", { start: "3" }, el("li", {}, t("c")), el("li", {}, t("d"))))).toBe("3. c\n4. d");
  });

  test("a nested list indents to the parent item's content column", () => {
    expect(
      md(el("ul", {}, el("li", {}, t("outer"), el("ul", {}, el("li", {}, t("inner")))))),
    ).toBe("- outer\n  - inner");
  });

  test("a nested list under an ordered item indents past the wider marker", () => {
    expect(md(el("ol", {}, el("li", {}, t("one"), el("ol", {}, el("li", {}, t("deep"))))))).toBe(
      "1. one\n   1. deep",
    );
  });

  test("a checkbox item becomes a task, and its state travels", () => {
    const item = (checked: boolean, label: string) =>
      el(
        "li",
        {},
        el("input", checked ? { type: "checkbox", checked: "" } : { type: "checkbox" }),
        t(label),
      );
    expect(md(el("ul", {}, item(true, "done"), item(false, "todo")))).toBe("- [x] done\n- [ ] todo");
  });

  test("a list item holding two blocks makes the whole list loose, so it still parses", () => {
    expect(
      md(el("ul", {}, el("li", {}, el("p", {}, t("a")), el("p", {}, t("b"))), el("li", {}, t("c")))),
    ).toBe("- a\n\n  b\n\n- c");
  });

  test("a list hung off its parent with no li around it is still a level", () => {
    expect(md(el("ul", {}, el("li", {}, t("one")), el("ul", {}, el("li", {}, t("deeper")))))).toBe(
      "- one\n  - deeper",
    );
  });
});

describe("blockquotes", () => {
  test("a quote marks every line, and the blank ones between its blocks", () => {
    expect(md(el("blockquote", {}, el("p", {}, t("one")), el("p", {}, t("two"))))).toBe(
      "> one\n>\n> two",
    );
  });

  test("a quoted list keeps both markers", () => {
    expect(md(el("blockquote", {}, el("ul", {}, el("li", {}, t("x")))))).toBe("> - x");
  });
});

describe("tables", () => {
  const cell = (tag: string, text: string, attrs: Record<string, string> = {}) => el(tag, attrs, t(text));

  test("a table with a header row becomes a GFM table", () => {
    expect(
      md(
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, cell("th", "a"), cell("th", "b"))),
          el("tbody", {}, el("tr", {}, cell("td", "1"), cell("td", "2"))),
        ),
      ),
    ).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  test("a headerless table promotes its first row — GFM has no other shape", () => {
    expect(
      md(el("table", {}, el("tr", {}, cell("td", "1"), cell("td", "2")), el("tr", {}, cell("td", "3"), cell("td", "4")))),
    ).toBe("| 1 | 2 |\n| --- | --- |\n| 3 | 4 |");
  });

  test("header alignment travels into the delimiter row", () => {
    expect(
      md(
        el(
          "table",
          {},
          el("tr", {}, cell("th", "a", { align: "right" }), cell("th", "b", { style: "text-align: center" })),
        ),
      ),
    ).toBe("| a | b |\n| ---: | :---: |");
  });

  test("a pipe inside a cell is escaped, and a break inside one is flattened", () => {
    expect(
      md(el("table", {}, el("tr", {}, el("td", {}, t("a|b")), el("td", {}, t("c"), el("br", {}), t("d"))))),
    ).toBe("| a\\|b | c d |\n| --- | --- |");
  });

  test("a short row is padded to the table's width", () => {
    expect(
      md(el("table", {}, el("tr", {}, cell("th", "a"), cell("th", "b")), el("tr", {}, cell("td", "1")))),
    ).toBe("| a | b |\n| --- | --- |\n| 1 |  |");
  });

  test("a one-column table is a layout wrapper: its cells are just content", () => {
    expect(
      md(el("table", {}, el("tr", {}, el("td", {}, el("p", {}, t("hello")))), el("tr", {}, el("td", {}, el("p", {}, t("world")))))),
    ).toBe("hello\n\nworld");
  });
});

describe("escaping", () => {
  test("a line that starts with a bullet character does not become a bullet", () => {
    expect(md(el("p", {}, t("- not a list")))).toBe("\\- not a list");
  });

  test("a line that starts with a hash does not become a heading", () => {
    expect(md(el("p", {}, t("# not a heading")))).toBe("\\# not a heading");
  });

  test("a line that starts with a number does not become an ordered item", () => {
    expect(md(el("p", {}, t("1. not a list")))).toBe("1\\. not a list");
  });

  test("a line that starts with an angle bracket does not become a quote", () => {
    expect(md(el("p", {}, t(">quoted")))).toBe("\\>quoted");
  });

  test("a line of dashes does not become a thematic break", () => {
    expect(md(el("p", {}, t("---")))).toBe("\\---");
  });

  test("asterisks and brackets in prose stay prose", () => {
    expect(md(el("p", {}, t("a * b [c] `d`")))).toBe("a \\* b \\[c\\] \\`d\\`");
  });

  test("emphasis we generated is not escaped by the line-start rule", () => {
    expect(md(el("p", {}, el("strong", {}, t("Webhooks"))))).toBe("**Webhooks**");
  });

  test("a non-breaking space becomes an ordinary one", () => {
    expect(md(el("p", {}, t("a b")))).toBe("a b");
  });

  test("zero-width characters are dropped", () => {
    expect(md(el("p", {}, t("a​b")))).toBe("ab");
  });
});

describe("hasFormatting", () => {
  test("span-and-div soup carries no formatting — a terminal copy must paste as text", () => {
    expect(
      hasFormatting(
        body(
          el("span", { style: "color: rgb(50, 215, 75); font-family: monospace" }, t("$ ls")),
          el("div", {}, t("a.txt")),
        ),
      ),
    ).toBe(false);
  });

  test("a list is formatting", () => {
    expect(hasFormatting(body(el("ul", {}, el("li", {}, t("x")))))).toBe(true);
  });

  test("a styled bold span is formatting even with no tag to show for it", () => {
    expect(hasFormatting(body(el("span", { style: "font-weight: bold" }, t("x"))))).toBe(true);
  });

  test("a script tag is not formatting", () => {
    expect(hasFormatting(body(el("script", {}, t("var a = <b>")))).valueOf()).toBe(false);
  });
});

describe("richPasteMarkdown", () => {
  test("no HTML flavor means paste the text", () => {
    expect(richPasteMarkdown("plain", null)).toBeNull();
  });

  test("HTML with no formatting means paste the text", () => {
    expect(richPasteMarkdown("$ ls\na.txt", body(el("div", {}, t("$ ls")), el("div", {}, t("a.txt"))))).toBeNull();
  });

  test("a conversion that only rewrites whitespace is not worth doing", () => {
    expect(richPasteMarkdown("hello\n", body(el("p", {}, el("code", {}, t("hello")))))).toBe("`hello`");
    expect(richPasteMarkdown("`hello`\n", body(el("p", {}, el("code", {}, t("hello")))))).toBeNull();
  });

  test("a bulleted list is converted — the case the plain text throws away", () => {
    expect(
      richPasteMarkdown(
        "is there a way\ndo you offer",
        body(el("ul", {}, el("li", {}, t("is there a way")), el("li", {}, t("do you offer")))),
      ),
    ).toBe("- is there a way\n- do you offer");
  });
});

describe("blockPasteInsert", () => {
  test("block markdown pasted mid-line opens a line of its own", () => {
    expect(blockPasteInsert("notes so far", "- a\n- b")).toBe("\n- a\n- b");
  });

  test("on an empty line it lands where the caret is", () => {
    expect(blockPasteInsert("   ", "- a\n- b")).toBe("- a\n- b");
  });

  test("inline markdown pasted mid-sentence stays where the caret is", () => {
    expect(blockPasteInsert("see ", "[docs](https://x.dev)")).toBe("[docs](https://x.dev)");
  });
});
