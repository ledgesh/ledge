import { test, expect, describe } from "bun:test";
import { parseAnsi } from "./ansi";

// Collapse chunks to a compact [text, style] shape for readable assertions.
const flat = (input: string) => parseAnsi(input).map((c) => [c.text, c.style] as const);

describe("parseAnsi", () => {
  test("plain text is one unstyled chunk", () => {
    expect(flat("hello world")).toEqual([["hello world", ""]]);
  });

  test("empty input yields no chunks", () => {
    expect(parseAnsi("")).toEqual([]);
  });

  test("basic 16-colour foreground", () => {
    // 32 = green -> ANSI16[2]
    expect(flat("\x1b[32mgreen\x1b[0m")).toEqual([["green", "color:#2ea043"]]);
  });

  test("background colour", () => {
    // 42 = green background -> ANSI16[2]
    expect(flat("\x1b[42mx\x1b[0m")).toEqual([["x", "background-color:#2ea043"]]);
  });

  test("bright foreground maps to the high half of the palette", () => {
    // 92 = bright green -> ANSI16[10]
    expect(flat("\x1b[92mx")).toEqual([["x", "color:#46c46a"]]);
  });

  test("bold combines with colour", () => {
    // 34 = blue -> ANSI16[4]
    expect(flat("\x1b[1;34mBB\x1b[0m")).toEqual([["BB", "color:#3b82f6;font-weight:600"]]);
  });

  test("italic and underline", () => {
    expect(flat("\x1b[3;4mx")).toEqual([["x", "font-style:italic;text-decoration:underline"]]);
  });

  test("dim adds opacity", () => {
    expect(flat("\x1b[2mx")).toEqual([["x", "opacity:0.7"]]);
  });

  test("256-colour cube", () => {
    // 196 -> r=5,g=0,b=0 -> rgb(255,0,0)
    expect(flat("\x1b[38;5;196mx")).toEqual([["x", "color:rgb(255,0,0)"]]);
  });

  test("256-colour grayscale ramp", () => {
    // 244 -> 8 + (244-232)*10 = 128
    expect(flat("\x1b[38;5;244mx")).toEqual([["x", "color:rgb(128,128,128)"]]);
  });

  test("truecolour", () => {
    expect(flat("\x1b[38;2;10;20;30mx")).toEqual([["x", "color:rgb(10,20,30)"]]);
  });

  test("inverse swaps fg/bg, filling theme defaults", () => {
    expect(flat("\x1b[7mx")).toEqual([["x", "color:var(--panel-bg);background-color:var(--fg)"]]);
  });

  test("reset ends a styled run", () => {
    expect(flat("\x1b[31ma\x1b[0mb")).toEqual([
      ["a", "color:#d0453b"],
      ["b", ""],
    ]);
  });

  test("ESC[m with no params is a reset", () => {
    expect(flat("\x1b[31ma\x1b[mb")).toEqual([
      ["a", "color:#d0453b"],
      ["b", ""],
    ]);
  });

  test("non-SGR CSI sequences (cursor move / clear) are skipped, not printed", () => {
    expect(flat("\x1b[2J\x1b[Hclear")).toEqual([["clear", ""]]);
  });

  test("OSC sequences are skipped (BEL-terminated)", () => {
    expect(flat("\x1b]0;window title\x07after")).toEqual([["after", ""]]);
  });

  test("OSC sequences are skipped (ST-terminated)", () => {
    expect(flat("\x1b]0;t\x1b\\after")).toEqual([["after", ""]]);
  });

  test("CRLF is normalised to LF", () => {
    expect(flat("a\r\nb")).toEqual([["a\nb", ""]]);
  });

  test("lone CR is dropped", () => {
    expect(flat("a\rb")).toEqual([["ab", ""]]);
  });

  test("style carries across text until changed", () => {
    expect(flat("\x1b[31mred\x1b[32mgreen")).toEqual([
      ["red", "color:#d0453b"],
      ["green", "color:#2ea043"],
    ]);
  });

  test("39/49 reset fg/bg to default without clearing other attrs", () => {
    // bold + red, then default-fg: keeps bold, drops colour.
    expect(flat("\x1b[1;31ma\x1b[39mb")).toEqual([
      ["a", "color:#d0453b;font-weight:600"],
      ["b", "font-weight:600"],
    ]);
  });
});
