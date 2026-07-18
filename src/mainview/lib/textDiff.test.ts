// changedSpan feeds reloadOpenNotes' dispatch, so what these pin down is the
// positional story: an external append must become an insertion AT THE END,
// not a whole-document replace, or every anchored position teleports.
import { describe, expect, test } from "bun:test";
import { changedSpan } from "./textDiff";

// Apply a span the way CodeMirror would, so every case can assert round-trip
// correctness besides its shape.
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
    // "😀" -> "😁": the halves share the high surrogate; a code-unit trim
    // would leave a lone surrogate in both span and insert.
    const span = changedSpan("a😀", "a😁")!;
    expect(apply("a😀", span)).toBe("a😁");
    expect(span.insert).toBe("😁");
    const back = changedSpan("a😁", "a😀")!;
    expect(apply("a😁", back)).toBe("a😀");
  });

  test("emoji appended after emoji stays a whole-character insertion", () => {
    const span = changedSpan("a😀b", "a😀😀b")!;
    expect(apply("a😀b", span)).toBe("a😀😀b");
    // The inserted text must itself be a valid pair, not half of each.
    expect([...span.insert].every((ch) => ch.length === 2 || ch.charCodeAt(0) < 0xd800)).toBe(true);
  });
});
