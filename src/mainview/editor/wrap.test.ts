import { test, expect, describe } from "bun:test";
import { hangingIndentCols } from "./wrap";

describe("hangingIndentCols", () => {
  test("plain text and empty lines have no hang", () => {
    expect(hangingIndentCols("just some prose")).toBe(0);
    expect(hangingIndentCols("")).toBe(0);
  });

  test("leading whitespace is the hang column (indented code / continuation)", () => {
    expect(hangingIndentCols("    def f():")).toBe(4);
    expect(hangingIndentCols("\tx")).toBe(1); // tab counts as one column
  });

  test("bullet markers hang under the text", () => {
    expect(hangingIndentCols("- item")).toBe(2);
    expect(hangingIndentCols("* item")).toBe(2);
    expect(hangingIndentCols("+ item")).toBe(2);
  });

  test("ordered markers include the number width", () => {
    expect(hangingIndentCols("1. item")).toBe(3);
    expect(hangingIndentCols("10. item")).toBe(4);
    expect(hangingIndentCols("1) item")).toBe(3);
  });

  test("blockquotes and nesting stack", () => {
    expect(hangingIndentCols("> quote")).toBe(2);
    expect(hangingIndentCols("  - nested")).toBe(4); // 2 spaces + "- "
    expect(hangingIndentCols("> - x")).toBe(4); // "> " + "- "
  });

  test("a marker without following whitespace is not a marker", () => {
    expect(hangingIndentCols("-")).toBe(0);
    expect(hangingIndentCols("---")).toBe(0); // thematic break, not a bullet
    expect(hangingIndentCols("-x")).toBe(0);
  });

  test("headings and code fences do not hang", () => {
    expect(hangingIndentCols("# Heading")).toBe(0);
    expect(hangingIndentCols("```py")).toBe(0);
  });
});
