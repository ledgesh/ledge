// A fresh start opens the welcome note, and the welcome note runs.
//
// A first launch on a Mac and a first connection to a server with no notes
// yet both boot with nothing to open, and what opens instead is the seeded
// welcome note (workspace/seeds.ts). The manual's own blocks are marked
// `norun` (fences.spec.ts, docs.spec.ts), so this note is the one place a new
// user is invited to press Run: every block in it must wear the pair, and
// pressing it must reach the shell.
import { expect, test } from "@playwright/test";

// Tall enough to hold the whole note: CodeMirror renders only the viewport,
// and a block scrolled off the bottom has no buttons in the DOM to count.
test.use({ viewport: { width: 1200, height: 1800 } });

test("a fresh start opens the welcome note with every block runnable", async ({ page }) => {
  await page.goto("/harness.html?fresh");
  await expect(page.locator(".cm-line").first()).toHaveText("# Welcome to Ledge");
  await expect(page.locator("[data-tab]", { hasText: "Welcome to Ledge" })).toBeVisible();

  // Four fences, four run pairs: nothing in the note is marked norun.
  await expect(page.locator('[data-act="run"]')).toHaveCount(4);
  await expect(page.locator('[data-act="term"]')).toHaveCount(4);

  // The first block, run by the chord from inside it, reaches the shell.
  await page.locator(".cm-line", { hasText: "api.github.com/zen" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns().length)).toBe(1);
});

test("a folder with a note in it opens that note, not the welcome note", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await expect(page.locator(".cm-line").first()).not.toHaveText("# Welcome to Ledge");
});
