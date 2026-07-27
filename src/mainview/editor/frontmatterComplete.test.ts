import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { configureBridge } from "./bridge";
import { frontmatterCompletionSource } from "./frontmatterComplete";

// The bridge is module-global; registering workspaceTags here is the same
// stubbing-at-the-seam move as tags.test.ts beside it.
configureBridge({
  workspaceTags: () => [
    { tag: "work", count: 2 },
    { tag: "project/ledge", count: 1 },
  ],
});

// No parser in the extensions: the source reads the block by text (the same
// frontmatterLineSpan the styling uses), never the syntax tree.
function complete(docText: string, pos: number, explicit = false): CompletionResult | null {
  const state = EditorState.create({ doc: docText });
  return frontmatterCompletionSource(new CompletionContext(state, pos, explicit));
}

const labels = (r: CompletionResult | null) => r?.options.map((o) => o.label);

describe("frontmatterCompletionSource: keys", () => {
  test("typing at the start of a body line offers the params keys, hinted", () => {
    const r = complete("---\ncw\n---\n", 6);
    expect(r?.from).toBe(4);
    expect(labels(r)).toEqual(["cwd", "profile", "envFile", "env", "host", "tags", "template", "confirm"]);
    // Every key carries its one-line hint — the popup is the documentation.
    expect(r?.options.every((o) => typeof o.detail === "string" && o.detail.length > 0)).toBe(true);
    // Accepting a key writes the colon too, so the caret lands at the value.
    expect(r?.options[0]?.apply).toBe("cwd: ");
    expect(r?.options.find((o) => o.label === "env")?.apply).toBe("env:\n  ");
  });

  test("keys the block already declares are not offered again", () => {
    const r = complete("---\ncwd: /x\nc\n---\n", 13);
    expect(labels(r)).not.toContain("cwd");
    expect(labels(r)).toContain("profile");
  });

  test("an empty line pops only on an explicit ask", () => {
    expect(complete("---\n\n---\n", 4)).toBeNull();
    expect(labels(complete("---\n\n---\n", 4, true))).toHaveLength(8);
  });

  test("silent on the fences, outside the block, and without a block", () => {
    expect(complete("---\ncw\n---\nte", 3)).toBeNull(); // opening fence
    expect(complete("---\ncw\n---\nte", 13)).toBeNull(); // past the block
    expect(complete("# plain\ncw", 10)).toBeNull(); // no block at all
  });

  test("silent on env's indented lines — their names are free-form", () => {
    expect(complete("---\nenv:\n  P\n---\n", 12)).toBeNull();
  });
});

describe("frontmatterCompletionSource: values", () => {
  test("template: offers exactly the grammar, each value explained", () => {
    const r = complete("---\ntemplate: d\n---\n", 15);
    expect(r?.from).toBe(14);
    expect(labels(r)).toEqual(["true", "daily", "false"]);
  });

  test("confirm: offers exactly true and false, each explained", () => {
    const r = complete("---\nconfirm: t\n---\n", 14);
    expect(r?.from).toBe(13);
    expect(labels(r)).toEqual(["true", "false"]);
    expect(r?.options.every((o) => typeof o.detail === "string" && o.detail.length > 0)).toBe(true);
  });

  test("tags: offers the workspace's tags with counts, like the # picker", () => {
    const r = complete("---\ntags: w\n---\n", 11);
    expect(r?.from).toBe(10);
    expect(labels(r)).toEqual(["work", "project/ledge"]);
    expect(r?.options[0]?.detail).toBe("2");
  });

  test("tags already on the line are not offered again", () => {
    expect(labels(complete("---\ntags: work, w\n---\n", 17))).toEqual(["project/ledge"]);
  });

  test("host: teaches the reserved word local, once", () => {
    expect(labels(complete("---\nhost: l\n---\n", 11))).toEqual(["local"]);
    expect(complete("---\nhost: local, x\n---\n", 18)).toBeNull();
  });

  test("profile: completes nothing — the view holds no profile list", () => {
    expect(complete("---\nprofile: x\n---\n", 14)).toBeNull();
  });
});
