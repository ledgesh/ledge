// The table model core, tested against @lezer/markdown + GFM directly, like
// livePreview.test.ts: values in, render-ready cells out, no DOM.
import { describe, expect, test } from "bun:test";
import { GFM, parser } from "@lezer/markdown";
import { tableModels, type TableModel } from "./tables";

const md = parser.configure([GFM]);

const doc = (text: string) => ({
  sliceString: (from: number, to: number) => text.slice(from, to),
});

function models(text: string): TableModel[] {
  return tableModels(doc(text), md.parse(text));
}

// A cell's plain reading: every segment's text joined.
function cellText(m: TableModel, row: number, col: number): string {
  const cells = row < 0 ? m.header : m.rows[row]!;
  return cells[col]!.segs.map((s) => s.text).join("");
}

const BASIC = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";

describe("tableModels", () => {
  test("a pipe table models its header, rows and span", () => {
    const [m] = models(BASIC);
    expect(m).toBeDefined();
    expect(m!.from).toBe(0);
    expect(BASIC.slice(m!.from, m!.to)).toBe(BASIC.trimEnd());
    expect(m!.header.map((c) => c.segs[0]!.text)).toEqual(["a", "b"]);
    expect(m!.rows.map((r) => r.map((c) => c.segs[0]!.text))).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("cells know where they live — the click-to-caret anchor", () => {
    const [m] = models(BASIC);
    expect(BASIC.slice(m!.header[0]!.pos, m!.header[0]!.pos + 1)).toBe("a");
    expect(BASIC.slice(m!.rows[1]![1]!.pos, m!.rows[1]![1]!.pos + 1)).toBe("4");
  });

  test("the delimiter row's colons become per-column alignment", () => {
    const [m] = models("| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |\n");
    expect(m!.align).toEqual(["left", "center", "right", null]);
  });

  test("inline syntax inside a cell conceals and styles like prose", () => {
    const [m] = models("| h |\n| --- |\n| **bold** and `code` |\n");
    const segs = m!.rows[0]![0]!.segs;
    expect(segs.map((s) => s.text).join("")).toBe("bold and code");
    expect(segs.find((s) => s.text === "bold")!.styles).toEqual(["strong"]);
    expect(segs.find((s) => s.text === "code")!.styles).toEqual(["code"]);
    expect(segs.find((s) => s.text === " and ")!.styles).toEqual([]);
  });

  test("a link in a cell keeps its text and carries its approved URL", () => {
    const [m] = models("| h |\n| --- |\n| [docs](https://e.com) |\n");
    const segs = m!.rows[0]![0]!.segs;
    expect(segs).toEqual([{ text: "docs", styles: [], url: "https://e.com", link: true }]);
  });

  test("an entity in a cell decodes; nested styles stack", () => {
    const [m] = models("| h |\n| --- |\n| AT&amp;T ***both*** |\n");
    const segs = m!.rows[0]![0]!.segs;
    expect(segs.map((s) => s.text).join("")).toBe("AT&T both");
    const both = segs.find((s) => s.text === "both")!;
    expect([...both.styles].sort()).toEqual(["em", "strong"]);
  });

  test("a short row still models — the widget pads to the header", () => {
    const [m] = models("| a | b |\n| --- | --- |\n| only |\n");
    expect(m!.rows[0]!).toHaveLength(1);
    expect(cellText(m!, 0, 0)).toBe("only");
  });

  test("a quoted table is not a model — QuoteMarks thread its range", () => {
    expect(models("> | a |\n> | - |\n> | 1 |\n")).toEqual([]);
  });

  test("prose with pipes but no delimiter row is not a table", () => {
    expect(models("a | b\nc | d\n")).toEqual([]);
  });
});
