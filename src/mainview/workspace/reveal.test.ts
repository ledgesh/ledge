import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { revealHeading, revealSelection } from "./reveal";

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

describe("revealHeading", () => {
  const headed = Text.of([
    "# Title",
    "",
    "prose mentioning Setup in passing",
    "## Setup",
    "body",
    "### Deep Dive ###",
    "Setext heading",
    "--------------",
  ]);

  test("lands on the ATX heading with that text, case-insensitively", () => {
    expect(revealHeading(headed, "setup")).toEqual({
      anchor: headed.line(4).from,
      head: headed.line(4).from,
    });
  });

  test("ignores prose that merely contains the words, and trims the ask", () => {
    expect(revealHeading(headed, "  Deep Dive  ").anchor).toBe(headed.line(6).from);
  });

  test("a closing #-run is not part of the heading's text", () => {
    expect(revealHeading(headed, "Deep Dive").anchor).toBe(headed.line(6).from);
  });

  test("a heading the note does not have degrades to the top, not a throw", () => {
    expect(revealHeading(headed, "nowhere")).toEqual({ anchor: 0, head: 0 });
  });

  test("setext headings are not anchors", () => {
    expect(revealHeading(headed, "Setext heading")).toEqual({ anchor: 0, head: 0 });
  });

  test("an empty heading goes to the top rather than matching everything", () => {
    expect(revealHeading(headed, "  ")).toEqual({ anchor: 0, head: 0 });
  });
});
