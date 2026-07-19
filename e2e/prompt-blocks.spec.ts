// A ```prompt fence is runnable out of the box: "prompt" ships in
// settings.blocks.runnable, so it gets the same Run/terminal overlay every
// runnable fence does. WHAT runs is Bun-side policy (runner.test.ts: the
// body feeds `claude -p` on stdin); what only the harness can prove is the
// default's wire-through — settings snapshot → blocks.ts runnable set →
// buttons on screen for this fence word and not for prose.
import { expect, test } from "@playwright/test";

test("a prompt fence gets the run overlay out of the box", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  // A fresh scratch note is header-only; replace it wholesale so the only
  // fence on screen is the prompt one.
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("```prompt\nSummarize this note as a haiku\n```\n");

  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  await expect(page.locator('[data-act="term"]')).toHaveCount(1);
});

test("a silent run names its silence instead of showing a bare header", async ({ page }) => {
  // Agent runs are the extreme case (`claude -p` says nothing until done),
  // but the placeholder is for every quiet command. The harness PTY is inert
  // — no bytes ever arrive — so the run holds the placeholder state forever.
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText('# Untitled\n\n```sh\necho "ready"\n```\n');
  await expect(page.locator(".cm-line", { hasText: 'echo "ready"' })).toBeVisible();
  await page.locator('[data-act="run"]').dispatchEvent("mousedown", { button: 0 });
  await expect(page.locator(".ledge-term-waiting")).toHaveText("running, no output yet");
});
