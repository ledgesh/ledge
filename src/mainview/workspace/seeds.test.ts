// The welcome note is the one place a new user is meant to press Run, so it
// must actually offer to: every fence in it is a runnable language and none
// carries the manual's `norun` mark (the opposite invariant from
// bun/docsContent.test.ts, for the opposite reason). Its H1 is the tab's
// title, so the tab a fresh start opens reads the same as the note under it.
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../shared/settings";
import { headingOf } from "../../shared/slug";
import { noRun, parseFenceInfo } from "../editor/fenceInfo";
import { SCRATCH_DOC, WELCOME_DOC, WELCOME_TITLE, seedDoc } from "./seeds";

function openers(text: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const line of text.split("\n")) {
    if (!/^```/.test(line)) continue;
    if (open) {
      open = false;
      continue;
    }
    open = true;
    out.push(line);
  }
  expect(open).toBe(false); // every fence closed
  return out;
}

describe("the welcome note", () => {
  test("is titled for its tab", () => {
    expect(headingOf(WELCOME_DOC)).toBe(WELCOME_TITLE);
    expect(seedDoc("demo")).toBe(WELCOME_DOC);
  });

  test("every block runs: a runnable language, and no norun mark", () => {
    const infos = openers(WELCOME_DOC);
    expect(infos.length).toBeGreaterThanOrEqual(3);
    for (const raw of infos) {
      const info = parseFenceInfo(raw);
      expect(DEFAULT_SETTINGS.blocks.runnable).toContain(info.lang ?? "");
      expect(noRun(info.attrs)).toBe(false);
    }
  });

  test("keeps the manual's mechanics: no em dashes, one line per paragraph", () => {
    expect(WELCOME_DOC).not.toContain("—");
    expect(WELCOME_DOC).not.toMatch(/\n\n\n/);
  });
});

test("a scratch note is only its heading", () => {
  expect(seedDoc("scratch")).toBe(SCRATCH_DOC);
  expect(headingOf(SCRATCH_DOC)).toBe("Untitled");
  expect(openers(SCRATCH_DOC)).toEqual([]);
});
