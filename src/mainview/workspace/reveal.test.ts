import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { revealSelection } from "./reveal";

const doc = Text.of(["# Title", "", "the needle sits here", "last line"]);

describe("revealSelection", () => {
  test("selects the query where it sits on the hit's line, case-insensitively", () => {
    const sel = revealSelection(doc, 3, "NEEDLE");
    const from = doc.line(3).from + "the ".length;
    expect(sel).toEqual({ anchor: from, head: from + "needle".length });
  });

  test("a line the file no longer has clamps to the last line", () => {
    const sel = revealSelection(doc, 99, "nowhere");
    expect(sel.anchor).toBe(doc.line(doc.lines).from);
    expect(sel.head).toBe(sel.anchor);
  });

  test("a query no longer on its line degrades to the line start, not a throw", () => {
    const sel = revealSelection(doc, 3, "vanished");
    expect(sel).toEqual({ anchor: doc.line(3).from, head: doc.line(3).from });
  });

  test("an empty query is a bare go-to-line", () => {
    const sel = revealSelection(doc, 4, "  ");
    expect(sel).toEqual({ anchor: doc.line(4).from, head: doc.line(4).from });
  });
});
