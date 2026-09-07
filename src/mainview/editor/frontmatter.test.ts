import { describe, expect, test } from "bun:test";
import { effectiveProfileLine, frontmatterLineSpan, profileValueSpan, tagsValueSpans } from "./frontmatter";

describe("frontmatterLineSpan", () => {
  test("no frontmatter, no span", () => {
    expect(frontmatterLineSpan("# Title\nbody")).toBeNull();
    expect(frontmatterLineSpan("")).toBeNull();
    // An unterminated opener is content (a thematic break), not a block.
    expect(frontmatterLineSpan("---\ncwd: /x\n# T\n")).toBeNull();
  });

  test("the span covers opening fence through closing fence, inclusive", () => {
    expect(frontmatterLineSpan("---\ncwd: /x\n---\n# T\n")).toEqual({ first: 1, last: 3 });
    expect(frontmatterLineSpan("---\ncwd: /x\nenv:\n  A: 1\n---\nbody")).toEqual({ first: 1, last: 5 });
  });

  test("a closing fence with no trailing newline still ends its own line", () => {
    expect(frontmatterLineSpan("---\ncwd: /x\n---")).toEqual({ first: 1, last: 3 });
  });

  test("an empty block is two fence lines", () => {
    expect(frontmatterLineSpan("---\n---\n# T\n")).toEqual({ first: 1, last: 2 });
  });

  test("CRLF counts lines the same as LF", () => {
    expect(frontmatterLineSpan("---\r\ncwd: /x\r\n---\r\n# T\r\n")).toEqual({ first: 1, last: 3 });
  });
});

describe("profileValueSpan", () => {
  test("the span covers the raw token; the name is what a click opens", () => {
    expect(profileValueSpan("profile: petstore")).toEqual({ from: 9, to: 17, name: "petstore" });
    expect(profileValueSpan("profile:demo")).toEqual({ from: 8, to: 12, name: "demo" });
  });

  test("a quoted value underlines quotes and all, but opens the bare name", () => {
    const s = profileValueSpan('profile: "demo"');
    expect(s).toEqual({ from: 9, to: 15, name: "demo" });
  });

  test("other keys, indented lines, and non-profile text are not links", () => {
    // Indented lines are only meaningful under `env:` (shared/frontmatter.ts),
    // so an indented "profile:" is an env var. Spanning it would draw a link
    // to a profile that does not exist.
    expect(profileValueSpan("cwd: ~/x")).toBeNull();
    expect(profileValueSpan("  profile: demo")).toBeNull();
    expect(profileValueSpan("profiles: demo")).toBeNull();
  });

  test("a name the parser would refuse is no link", () => {
    // There is no profile for "../evil" or "two words" to open: isProfileName
    // refuses both names (shared/frontmatter.ts). The empty value never
    // reaches that check, because profileValueSpan's own regex requires a
    // non-space value.
    expect(profileValueSpan("profile: ../evil")).toBeNull();
    expect(profileValueSpan("profile: two words")).toBeNull();
    expect(profileValueSpan("profile:")).toBeNull();
  });
});

describe("tagsValueSpans", () => {
  test("each accepted token is a span; the tag is the bare spelling", () => {
    expect(tagsValueSpans("tags: work, #home")).toEqual([
      { from: 6, to: 10, tag: "work" },
      { from: 12, to: 17, tag: "home" },
    ]);
  });

  test("a refused token is no link, and costs only itself", () => {
    // Same rule as the profile name: isTagToken refuses "123"
    // (shared/frontmatter.ts). The parser counts no tag by that name, so a
    // pill on the token would show a tag nothing carries.
    expect(tagsValueSpans("tags: work 123 home").map((t) => t.tag)).toEqual(["work", "home"]);
    expect(tagsValueSpans("tags:")).toEqual([]);
  });

  test("other keys and indented lines are not tag lines", () => {
    expect(tagsValueSpans("cwd: ~/x")).toEqual([]);
    expect(tagsValueSpans("  tags: work")).toEqual([]);
    expect(tagsValueSpans("tagsy: work")).toEqual([]);
  });

  test("a wholly-quoted list degrades to no spans — styling, not parsing", () => {
    expect(tagsValueSpans('tags: "work home"')).toEqual([]);
  });

  test("a bracketed list is spanned inside the brackets", () => {
    // The parser strips the brackets from `[a, b]` (shared/frontmatter.ts
    // unbracket), and tagsValueSpans strips them at the same point. Otherwise
    // a list the parser accepts would render as refused tokens, with no pill
    // on either tag. The brackets themselves stay unstyled.
    expect(tagsValueSpans("tags: [ops, runbook]")).toEqual([
      { from: 7, to: 10, tag: "ops" },
      { from: 12, to: 19, tag: "runbook" },
    ]);
  });

  test("an unbalanced bracket is not stripped, and costs only its own token", () => {
    expect(tagsValueSpans("tags: [ops, runbook").map((t) => t.tag)).toEqual(["runbook"]);
  });
});

describe("effectiveProfileLine", () => {
  test("finds the profile line inside the block", () => {
    const p = effectiveProfileLine("---\ncwd: /x\nprofile: demo\n---\n# T\n");
    expect(p).toEqual({ lineNumber: 3, from: 9, to: 13, name: "demo" });
  });

  test("duplicates: the LAST usable line wins, matching the parser", () => {
    // The edit button must open the profile the shell would actually get.
    const p = effectiveProfileLine("---\nprofile: first\nprofile: second\n---\n");
    expect(p?.name).toBe("second");
    expect(p?.lineNumber).toBe(3);
  });

  test("no block, no profile line, or a profile outside the block: null", () => {
    expect(effectiveProfileLine("# plain\n")).toBeNull();
    expect(effectiveProfileLine("---\ncwd: /x\n---\n")).toBeNull();
    expect(effectiveProfileLine("---\ncwd: /x\n---\nprofile: after\n")).toBeNull();
  });
});
