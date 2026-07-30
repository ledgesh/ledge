import { describe, expect, test } from "bun:test";
import { htmlFromScriptOutput } from "./clipboard";

// Hex for `new TextEncoder().encode(text)`, the shape osascript prints.
function literal(text: string, prefix: number[] = []): string {
  const bytes = [...prefix, ...new TextEncoder().encode(text)];
  return `«data HTML${bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("")}»\n`;
}

describe("htmlFromScriptOutput", () => {
  test("the raw-data literal decodes to its bytes as UTF-8", () => {
    expect(htmlFromScriptOutput(literal("<b>hi</b>"))).toBe("<b>hi</b>");
  });

  test("multi-byte characters survive the round trip", () => {
    expect(htmlFromScriptOutput(literal("<p>café — ✓</p>"))).toBe("<p>café — ✓</p>");
  });

  test('a pasteboard with no HTML answers "none", which is no HTML', () => {
    expect(htmlFromScriptOutput("none\n")).toBe("");
  });

  test("empty output is no HTML", () => {
    expect(htmlFromScriptOutput("")).toBe("");
  });

  test("a UTF-16 flavor is decoded by its BOM, not as interleaved NULs", () => {
    const utf16 = [0xff, 0xfe];
    for (const ch of "<i>x</i>") utf16.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
    expect(htmlFromScriptOutput(`«data HTML${utf16.map((b) => b.toString(16).padStart(2, "0")).join("")}»`)).toBe(
      "<i>x</i>",
    );
  });

  test("a UTF-8 BOM is not left in the markup", () => {
    expect(htmlFromScriptOutput(literal("<b>x</b>", [0xef, 0xbb, 0xbf]))).toBe("<b>x</b>");
  });

  test("whitespace inside the hex run does not end it", () => {
    expect(htmlFromScriptOutput("«data HTML3C62\n3E783C\n2F623E»")).toBe("<b>x</b>");
  });

  test("a malformed literal is treated as no HTML — the caller still has the text", () => {
    expect(htmlFromScriptOutput("«data HTML3C6ZZZ»")).toBe("");
    expect(htmlFromScriptOutput("«class utf8» hello")).toBe("");
  });
});
