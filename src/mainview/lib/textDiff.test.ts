// changedSpan feeds the dispatch in reloadOpenNotes (workspace/editorPool.ts),
// so these tests check where the span lands. An external append must be an
// insertion at the end of the document, not a whole-document replace. A
// replace would move every anchored position.
import { describe, expect, test } from "bun:test";
import { changedSpan } from "./textDiff";

// A span applied the way CodeMirror would apply it, so the cases can assert
// the resulting text, not just the span's shape.
function apply(a: string, span: { from: number; to: number; insert: string }): string {
  return a.slice(0, span.from) + span.insert + a.slice(span.to);
}

describe("changedSpan", () => {
  test("identical texts are no change at all, not an empty change", () => {
    expect(changedSpan("# Note\nbody\n", "# Note\nbody\n")).toBeNull();
    expect(changedSpan("", "")).toBeNull();
  });

  test("an agent's append is an insertion at the end — nothing before it moves", () => {
    const a = "# Jokes\n\n```prompt\nadd a joke\n```\n";
    const b = a + "\n> the appended joke\n";
    const span = changedSpan(a, b)!;
    expect(span.from).toBe(a.length);
    expect(span.to).toBe(a.length); // pure insertion: no deletion span
    expect(apply(a, span)).toBe(b);
  });

  test("a change in the middle stays in the middle", () => {
    const span = changedSpan("one two three", "one 2 three")!;
    expect(span).toEqual({ from: 4, to: 7, insert: "2" });
  });

  test("a deletion is an empty insert over the deleted span", () => {
    const span = changedSpan("abcdef", "abef")!;
    expect(span).toEqual({ from: 2, to: 4, insert: "" });
    expect(apply("abcdef", span)).toBe("abef");
  });

  test("prepended text is an insertion at the start", () => {
    const span = changedSpan("body\n", "# New Title\n\nbody\n")!;
    expect(span.from).toBe(0);
    expect(apply("body\n", span)).toBe("# New Title\n\nbody\n");
  });

  test("repeated text does not confuse the trim (suffix cannot overlap the prefix)", () => {
    // Both strings are all "a"s: naive prefix+suffix would double-count.
    const span = changedSpan("aaa", "aaaaa")!;
    expect(apply("aaa", span)).toBe("aaaaa");
  });

  test("a surrogate pair is never split", () => {
    // "😀" and "😁" share their high surrogate. A code-unit trim would put
    // that half in the common prefix and leave a lone surrogate in both the
    // span and the insert.
    const span = changedSpan("a😀", "a😁")!;
    expect(apply("a😀", span)).toBe("a😁");
    expect(span.insert).toBe("😁");
    const back = changedSpan("a😁", "a😀")!;
    expect(apply("a😁", back)).toBe("a😀");
  });

  test("emoji appended after emoji stays a whole-character insertion", () => {
    const span = changedSpan("a😀b", "a😀😀b")!;
    expect(apply("a😀b", span)).toBe("a😀😀b");
    // The insert holds whole characters, not the trailing half of one emoji
    // followed by the leading half of the next.
    expect([...span.insert].every((ch) => ch.length === 2 || ch.charCodeAt(0) < 0xd800)).toBe(true);
  });
});
