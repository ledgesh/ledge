import { describe, expect, test } from "bun:test";
import { confirmFor, parseFenceInfo } from "./fenceInfo";

const attrsOf = (line: string) => Object.fromEntries(parseFenceInfo(line).attrs);

describe("parseFenceInfo", () => {
  test("reads the language, the first word, unchanged", () => {
    expect(parseFenceInfo("```sh").lang).toBe("sh");
    expect(parseFenceInfo("~~~python").lang).toBe("python");
    expect(parseFenceInfo("  ```` SQL ").lang).toBe("SQL"); // case survives
    expect(parseFenceInfo("```").lang).toBeNull();
    expect(parseFenceInfo("   ").lang).toBeNull();
    expect(parseFenceInfo("echo hi").lang).toBeNull(); // not an opener at all
  });

  test("a bare attribute is a flag; an = attribute carries its value", () => {
    expect(attrsOf("```sh confirm")).toEqual({ confirm: "" });
    expect(attrsOf("```sh confirm=no")).toEqual({ confirm: "no" });
    expect(attrsOf("```sh title=deploy confirm")).toEqual({ title: "deploy", confirm: "" });
  });

  test("quotes let a value hold spaces, and are dropped", () => {
    expect(attrsOf('```sh confirm="Wipe the build cache?"')).toEqual({
      confirm: "Wipe the build cache?",
    });
    expect(attrsOf("```sh confirm='Drop the table?'")).toEqual({ confirm: "Drop the table?" });
    // An unterminated quote costs the quote, not the attribute.
    expect(attrsOf('```sh confirm="Are you sure')).toEqual({ confirm: "Are you sure" });
    expect(attrsOf('```js title=""')).toEqual({ title: "" });
  });

  test("names are case-folded and a repeat replaces, frontmatter's rule", () => {
    expect(attrsOf("```sh CONFIRM")).toEqual({ confirm: "" });
    expect(attrsOf("```sh confirm confirm=no")).toEqual({ confirm: "no" });
  });

  test("another tool's syntax in the same slot is ignored, never fatal", () => {
    // mdBook, Docusaurus, and line-range highlighters all write here.
    const info = parseFenceInfo("```rust,no_run {1,3} showLineNumbers confirm");
    expect(info.lang).toBe("rust,no_run");
    expect(info.attrs.get("showlinenumbers")).toBe("");
    expect(info.attrs.get("confirm")).toBe("");
    expect(info.attrs.has("{1,3}")).toBe(false);
  });

  test("a fence whose first word is an attribute names no language", () => {
    // ```confirm=yes declares nothing runnable; calling "confirm=yes" a
    // language would invent a fence word out of a marker.
    expect(parseFenceInfo("```confirm=yes").lang).toBeNull();
    expect(attrsOf("```confirm=yes")).toEqual({ confirm: "yes" });
  });
});

describe("confirmFor", () => {
  const of = (line: string, noteDefault = false) => confirmFor(parseFenceInfo(line).attrs, noteDefault);

  test("no marker, no note default: nothing interposes", () => {
    expect(of("```sh")).toBeNull();
  });

  test("the bare flag asks with the default question", () => {
    expect(of("```sh confirm")).toEqual({ message: null });
    expect(of("```sh confirm=true")).toEqual({ message: null });
    expect(of("```sh confirm=YES")).toEqual({ message: null });
  });

  test("any other value is the question to ask", () => {
    expect(of('```sh confirm="Wipe ./cache?"')).toEqual({ message: "Wipe ./cache?" });
  });

  test("the note default applies to unmarked blocks, and a block can opt out", () => {
    expect(of("```sh", true)).toEqual({ message: null });
    expect(of("```sh confirm=no", true)).toBeNull();
    expect(of("```sh confirm=off", true)).toBeNull();
    expect(of('```sh confirm="Really?"', true)).toEqual({ message: "Really?" });
  });
});
