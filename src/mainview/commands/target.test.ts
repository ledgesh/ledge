import { describe, expect, test } from "bun:test";
import { targetAttrs, targetFromDataset, type TargetDataset } from "./target";

// datasetOf camel-cases the attribute names from targetAttrs the way the DOM
// does, so targetFromDataset reads them as it would a row's dataset:
// "data-target-path" becomes targetPath.
function datasetOf(attrs: Record<string, string>): TargetDataset {
  const d: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    d[k.replace(/^data-/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return d as TargetDataset;
}

describe("targetAttrs / targetFromDataset", () => {
  test("round-trips every target kind", () => {
    const cases = [
      { kind: "note", path: "/n/a.md" },
      { kind: "trash", path: "/n/.ledge-trash/a.md" },
      { kind: "backlink", path: "/n/a.md", line: 3, raw: "[[Alpha]]" },
      { kind: "heading", docId: "doc1", line: 7, text: "Setup" },
      { kind: "tag", tag: "project/ledge" },
      { kind: "tagnote", path: "/n/a.md", line: 4, raw: "#work" },
      { kind: "workspace", id: "ws1" },
      { kind: "tab", paneId: "p1", tabId: "t1" },
      { kind: "pane", paneId: "p1" },
    ] as const;
    for (const target of cases) {
      expect(targetFromDataset(datasetOf(targetAttrs(target)))).toEqual(target);
    }
  });

  test("note and trash stay distinct kinds at the same path", () => {
    // Pressing `d` on a note row runs Delete; on a trash row it runs Delete
    // Permanently… (keys.ts). Conflating the kinds would aim the wrong verb
    // at a file.
    expect(targetFromDataset(datasetOf(targetAttrs({ kind: "note", path: "/a.md" })))).toEqual({
      kind: "note",
      path: "/a.md",
    });
    expect(targetFromDataset(datasetOf(targetAttrs({ kind: "trash", path: "/a.md" })))).toEqual({
      kind: "trash",
      path: "/a.md",
    });
  });

  test("an unknown kind or a half-set row yields no target", () => {
    expect(targetFromDataset({})).toBeUndefined();
    expect(targetFromDataset({ targetKind: "nonsense" })).toBeUndefined();
    expect(targetFromDataset({ targetKind: "note" })).toBeUndefined(); // no path
    expect(targetFromDataset({ targetKind: "tab", targetPane: "p1" })).toBeUndefined(); // no tab
    // A garbled line yields no target at all, rather than a jump to NaN.
    expect(
      targetFromDataset({ targetKind: "heading", targetId: "doc1", targetLine: "x" }),
    ).toBeUndefined();
    expect(targetFromDataset({ targetKind: "tag" })).toBeUndefined(); // no tag
    expect(
      targetFromDataset({ targetKind: "tagnote", targetPath: "/a.md", targetLine: "x" }),
    ).toBeUndefined();
  });
});
