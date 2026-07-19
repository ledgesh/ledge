import { describe, expect, test } from "bun:test";
import { stripJsonc } from "./jsonc";

const parse = (text: string) => JSON.parse(stripJsonc(text));

describe("stripJsonc", () => {
  test("plain JSON passes through untouched", () => {
    const text = '{\n  "a": [1, 2],\n  "b": "x"\n}';
    expect(stripJsonc(text)).toBe(text);
  });

  test("line comments go, in every position", () => {
    expect(
      parse(`// leading
{
  "a": 1, // trailing
  // whole line
  "b": 2
} // after`),
    ).toEqual({ a: 1, b: 2 });
  });

  test("block comments go, including multi-line and mid-value", () => {
    expect(parse('{ /* one */ "a": /* two\nlines */ 1 }')).toEqual({ a: 1 });
  });

  test("comment-shaped text inside strings is content, not a comment", () => {
    expect(parse('{ "url": "https://x/*y", "cmd": "a // b", "c": "/* not */" }')).toEqual({
      url: "https://x/*y",
      cmd: "a // b",
      c: "/* not */",
    });
  });

  test("escaped quotes do not end the string early", () => {
    expect(parse('{ "a": "say \\"hi\\" // still string" }')).toEqual({ a: 'say "hi" // still string' });
  });

  test("trailing commas are dropped in objects and arrays, across whitespace and comments", () => {
    expect(parse('{ "a": [1, 2,], "b": { "c": 3, }, }')).toEqual({ a: [1, 2], b: { c: 3 } });
    expect(parse('{ "a": 1, // note\n }')).toEqual({ a: 1 });
  });

  test("commas inside strings survive", () => {
    expect(parse('{ "a": ",}", "b": ",]" }')).toEqual({ a: ",}", b: ",]" });
  });

  test("separating commas survive — only trailing ones go", () => {
    expect(parse('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  test("comments strip to spaces, so error offsets still map to the file", () => {
    const text = '{ // x\n  "a": 1 }';
    expect(stripJsonc(text).length).toBe(text.length);
    expect(stripJsonc(text).split("\n").length).toBe(2);
  });

  test("never throws: unterminated string and comment fall through to JSON.parse", () => {
    expect(() => stripJsonc('{ "a": "unclosed')).not.toThrow();
    expect(() => stripJsonc('{ /* unclosed')).not.toThrow();
    expect(() => parse('{ "a": "unclosed')).toThrow(); // JSON.parse is the complainer
  });

  test("genuinely broken JSON is still broken after stripping", () => {
    expect(() => parse('{ "a": }')).toThrow();
  });
});
