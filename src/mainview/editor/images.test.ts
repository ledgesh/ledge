// The image model core, tested against @lezer/markdown + GFM directly, like
// tables.test.ts: text in, render-ready models out, no DOM. imagePasteInsert
// is here too — it is the pure half of the ⌘V image path.
import { describe, expect, test } from "bun:test";
import { GFM, parser } from "@lezer/markdown";
import {
  imageModels,
  imagePasteInsert,
  imageSrcOf,
  type DocLines,
  type ImageModel,
} from "./images";

const md = parser.configure([GFM]);

// A plain string as the DocLines the core needs.
function doc(text: string): DocLines {
  return {
    sliceString: (from, to) => text.slice(from, to),
    lineAt(pos) {
      const from = text.lastIndexOf("\n", pos - 1) + 1;
      const end = text.indexOf("\n", pos);
      return { from, to: end === -1 ? text.length : end };
    },
  };
}

function models(text: string): ImageModel[] {
  return imageModels(doc(text), md.parse(text));
}

describe("imageSrcOf", () => {
  test("http(s) URLs are remote, taken as written", () => {
    expect(imageSrcOf("https://e.com/x.png")).toEqual({ kind: "remote", url: "https://e.com/x.png" });
    expect(imageSrcOf("http://e.com/x")).toEqual({ kind: "remote", url: "http://e.com/x" });
  });

  test("a bare www. host gets https, like openableUrl", () => {
    expect(imageSrcOf("www.e.com/x.png")).toEqual({ kind: "remote", url: "https://www.e.com/x.png" });
  });

  test("a remote URL needs no image extension — the server decides", () => {
    expect(imageSrcOf("https://e.com/render?id=4")).toEqual({
      kind: "remote",
      url: "https://e.com/render?id=4",
    });
  });

  test("a note-relative image path is an asset", () => {
    expect(imageSrcOf("assets/pasted-2026-07-17.png")).toEqual({
      kind: "asset",
      path: "assets/pasted-2026-07-17.png",
    });
    expect(imageSrcOf("assets/photo.JPG")).toEqual({ kind: "asset", path: "assets/photo.JPG" });
  });

  test("non-http schemes are refused — file: is the one that matters", () => {
    expect(imageSrcOf("file:///etc/passwd")).toBeNull();
    expect(imageSrcOf("javascript:alert(1)")).toBeNull();
  });

  test("absolute paths, traversals and dot-entries are refused", () => {
    expect(imageSrcOf("/etc/passwd.png")).toBeNull();
    expect(imageSrcOf("../outside.png")).toBeNull();
    expect(imageSrcOf("assets/../../x.png")).toBeNull();
    expect(imageSrcOf(".trash/x.png")).toBeNull();
  });

  test("a relative path without an image extension is not attempted", () => {
    expect(imageSrcOf("assets/notes.md")).toBeNull();
    expect(imageSrcOf("assets/archive")).toBeNull();
  });

  test("whitespace and emptiness are refused", () => {
    expect(imageSrcOf("")).toBeNull();
    expect(imageSrcOf("a b.png")).toBeNull();
  });
});

describe("imageModels", () => {
  test("an image alone on its line models with its alt, source and line span", () => {
    const text = "before\n\n![a chart](https://e.com/x.png)\n\nafter\n";
    const [m] = models(text);
    expect(m).toBeDefined();
    expect(text.slice(m!.from, m!.to)).toBe("![a chart](https://e.com/x.png)");
    expect(text.slice(m!.lineFrom, m!.lineTo)).toBe("![a chart](https://e.com/x.png)");
    expect(m!.alt).toBe("a chart");
    expect(m!.src).toEqual({ kind: "remote", url: "https://e.com/x.png" });
  });

  test("an empty alt models as empty — the pasted-image form", () => {
    const [m] = models("![](assets/pasted-2026-07-17.png)\n");
    expect(m!.alt).toBe("");
    expect(m!.src).toEqual({ kind: "asset", path: "assets/pasted-2026-07-17.png" });
  });

  test("surrounding whitespace still counts as alone", () => {
    expect(models("  ![x](https://e.com/x.png)  \n")).toHaveLength(1);
  });

  test("an image inline in prose does not model — prose keeps its flow", () => {
    expect(models("see ![x](https://e.com/x.png) here\n")).toHaveLength(0);
  });

  test("a quoted or listed image does not model — the marker shares its line", () => {
    expect(models("> ![x](https://e.com/x.png)\n")).toHaveLength(0);
    expect(models("- ![x](https://e.com/x.png)\n")).toHaveLength(0);
  });

  test("two images on one line stay raw; each on its own line both model", () => {
    expect(models("![a](https://e.com/a.png) ![b](https://e.com/b.png)\n")).toHaveLength(0);
    expect(models("![a](https://e.com/a.png)\n![b](https://e.com/b.png)\n")).toHaveLength(2);
  });

  test("an unrenderable target does not model — it stays livePreview's problem", () => {
    expect(models("![x](file:///etc/passwd)\n")).toHaveLength(0);
    expect(models("![x](../outside.png)\n")).toHaveLength(0);
  });

  test("a reference-style image (no inline URL) does not model", () => {
    expect(models("![x][ref]\n\n[ref]: https://e.com/x.png\n")).toHaveLength(0);
  });
});

describe("imagePasteInsert", () => {
  const at = (text: string, pos: number, src = "assets/p.png") =>
    imagePasteInsert(doc(text), { from: pos, to: pos }, src);

  // The trailing newline and the caret-after-it are the rule everywhere: the
  // caret must land BELOW the image's line so the paste renders immediately
  // instead of sitting revealed as raw markdown.

  test("on a blank line: bare markdown plus the trailing break, caret below", () => {
    const { insert, cursor } = at("abc\n\n", 4);
    expect(insert).toBe("![](assets/p.png)\n");
    expect(cursor).toBe(insert.length);
  });

  test("mid-line it breaks onto its own line on both sides", () => {
    const text = "hello world\n";
    const { insert, cursor } = at(text, 5);
    expect(insert).toBe("\n![](assets/p.png)\n");
    expect(cursor).toBe(insert.length);
  });

  test("at the end of a nonempty line a leading break is added too", () => {
    const { insert, cursor } = at("hello\n", 5);
    expect(insert).toBe("\n![](assets/p.png)\n");
    expect(cursor).toBe(insert.length);
  });

  test("replacing a selection keeps the line rule against what survives", () => {
    // "world" is selected; "hello " remains before it on the line.
    const text = "hello world\n";
    const { insert } = imagePasteInsert(doc(text), { from: 6, to: 11 }, "assets/p.png");
    expect(insert).toBe("\n![](assets/p.png)\n");
  });
});
