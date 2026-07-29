// A fenced block gets an end, and only a block WITH an end offers to run.
//
// Two halves of one story. Enter on an opener closes the fence even when
// another block already sits below it (editor/fences.ts): without that, the
// closer down there pairs with the new opener instead and swallows the block
// between them. And a block left unterminated draws no run pair and refuses
// the chord (editor/blocks.ts): Lezer ends an unclosed node on the last BODY
// line, so what used to reach the shell was a body one line short — an empty
// one, for a one-line block, which `source`d cleanly and reported exit 0
// having run nothing at all.
import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
});

// Replace the note with `body`. Written whole rather than typed, so the fences
// land exactly as spelled (autoclose would otherwise answer the openers).
async function write(page: Page, body: string) {
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(body);
}

// The document as written, read back through the clipboard seam (lists.spec.ts).
async function raw(page: Page): Promise<string> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  const text = await page.evaluate(() => window.__harness.clipboard());
  await page.keyboard.press("ArrowRight"); // collapse to the end
  return text;
}

test("a fence typed above an existing block closes there and then", async ({ page }) => {
  await write(page, "\n```sh\npwd\n```\n");
  await page.locator(".cm-line").first().click();
  await page.keyboard.type("```");

  // The closer arrives with the third backtick, so the block below is never
  // swallowed — it is still its own block, and still offers to run.
  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  expect(await raw(page)).toBe("```\n```\n```sh\npwd\n```\n");
});

test("Enter closes an opener that arrived some other way", async ({ page }) => {
  // Written whole, the way a paste (or a note already saved mid-block) arrives:
  // nothing was typed, so the merged state is what opens.
  await write(page, "```\n\n```sh\npwd\n```\n");
  await expect(page.locator('[data-act="run"]')).toHaveCount(0);

  await page.locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");

  expect(await raw(page)).toBe("```\n\n```\n\n```sh\npwd\n```\n");
});

test("an unterminated fence draws no run pair, and its copy button still copies the body", async ({ page }) => {
  // No trailing newline: the note stops mid-block, which is the shape that
  // used to hand `source` an empty file.
  await write(page, "# Untitled\n\n```sh\npwd\n```\n\n```sh\nls");

  // One closed block, one open: only the closed one is offered.
  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  await expect(page.locator('[data-act="term"]')).toHaveCount(1);
  const groups = page.locator(".ledge-ctl-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1).locator("button")).toHaveCount(1); // copy alone

  // Copy reads the same body the runner would have, and an unclosed block's
  // body is every line after the opener: the last one is content, not a fence.
  await groups.nth(1).locator("button").dispatchEvent("mousedown", { button: 0 });
  await expect.poll(() => page.evaluate(() => window.__harness.clipboard())).toBe("ls");
});

test("the chord refuses an unterminated fence and says why", async ({ page }) => {
  await write(page, "# Untitled\n\n```sh\nls");
  await page.locator(".cm-line", { hasText: "ls" }).click();

  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("no closing fence", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);

  // The terminal destination is held to the same rule.
  await page.keyboard.press("Meta+Shift+Enter");
  expect(await page.evaluate(() => window.__harness.termPastes())).toHaveLength(0);
});

test("typing the closing fence brings the run pair with it", async ({ page }) => {
  await write(page, "# Untitled\n\n```sh\nls");
  await expect(page.locator('[data-act="run"]')).toHaveCount(0);

  await page.locator(".cm-line", { hasText: "ls" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("```");

  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  await page.keyboard.press("Meta+Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
});
