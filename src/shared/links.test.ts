import { describe, expect, test } from "bun:test";
import { openableUrl } from "./links";

describe("openableUrl", () => {
  test("http and https pass through untouched", () => {
    expect(openableUrl("https://example.com/docs?q=1#top")).toBe("https://example.com/docs?q=1#top");
    expect(openableUrl("http://example.com")).toBe("http://example.com");
  });

  test("schemes match case-insensitively", () => {
    expect(openableUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
  });

  test("surrounding whitespace is trimmed, inner whitespace refuses", () => {
    expect(openableUrl("  https://example.com  ")).toBe("https://example.com");
    expect(openableUrl("https://example.com/a b")).toBeNull();
  });

  test("a bare www. link gets https, the way GFM autolinks read", () => {
    expect(openableUrl("www.example.com/path")).toBe("https://www.example.com/path");
  });

  test("a bare email gets mailto, the way GFM autolinks read", () => {
    expect(openableUrl("dev@example.com")).toBe("mailto:dev@example.com");
    expect(openableUrl("mailto:dev@example.com")).toBe("mailto:dev@example.com");
  });

  test("javascript: is refused — the reason the list is an allowlist", () => {
    expect(openableUrl("javascript:alert(1)")).toBeNull();
    expect(openableUrl("JAVASCRIPT:alert(1)")).toBeNull();
  });

  test("file: and app schemes are refused", () => {
    expect(openableUrl("file:///etc/passwd")).toBeNull();
    expect(openableUrl("vscode://file/x")).toBeNull();
  });

  test("a plain path is not a URL — `open` would treat it as a file", () => {
    expect(openableUrl("/Applications/Calculator.app")).toBeNull();
    expect(openableUrl("./notes.md")).toBeNull();
    expect(openableUrl("notes.md")).toBeNull();
  });

  test("a scheme with nothing after it is refused", () => {
    expect(openableUrl("https:")).toBeNull();
    expect(openableUrl("")).toBeNull();
  });
});
