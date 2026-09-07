// A fresh start opens the welcome note, and every block in it draws a run
// pair. The welcome note fills the first tab when there is nothing else to
// open: a first launch on a Mac, or a first connection to a server with no
// notes (workspace/seeds.ts). The manual marks every runnable-language
// fence `norun` (bun/docsContent.test.ts). This note leaves its fences live.
import { expect, test } from "@playwright/test";

// The viewport is tall enough to hold the whole note. CodeMirror renders only
// what is in view, so a block scrolled off the bottom has no buttons in the
// DOM to count.
test.use({ viewport: { width: 1200, height: 1800 } });

test("a fresh start opens the welcome note with every block runnable", async ({ page }) => {
  await page.goto("/harness.html?fresh");
  await expect(page.locator(".cm-line").first()).toHaveText("# Welcome to Ledge");
  await expect(page.locator("[data-tab]", { hasText: "Welcome to Ledge" })).toBeVisible();

  // Each of the note's four fences draws a Run button and a Terminal button.
  // None of them is marked `norun`.
  await expect(page.locator('[data-act="run"]')).toHaveCount(4);
  await expect(page.locator('[data-act="term"]')).toHaveCount(4);

  // ⌘↩ runs the block holding the caret, so the click lands the caret in the
  // first fence. The harness has no PTY, so `inlineRuns` records that the view
  // asked for a run, not that a shell received it (harness.tsx, testing.md §6).
  await page.locator(".cm-line", { hasText: "api.github.com/zen" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns().length)).toBe(1);
});

test("a folder with a note in it opens that note, not the welcome note", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await expect(page.locator(".cm-line").first()).not.toHaveText("# Welcome to Ledge");
});
