// A ```prompt fence is runnable out of the box: "prompt" is one of
// settings.blocks.runnable. The run itself happens in Bun, which feeds the
// body to the `claude` CLI on stdin (src/bun/runner.ts, and runner.test.ts
// pins the command). This spec covers the on-screen half: blocks.ts reads
// that setting and draws the run/terminal overlay on this fence word.
import { expect, test } from "@playwright/test";

test("a prompt fence gets the run overlay out of the box", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  // A new note is its H1 and two empty lines (workspace/seeds.ts
  // SCRATCH_DOC). Selecting all and inserting replaces all three, so the
  // prompt fence is the only fence on screen.
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("```prompt\nSummarize this note as a haiku\n```\n");

  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  await expect(page.locator('[data-act="term"]')).toHaveCount(1);
});

test("a silent run names its silence instead of showing a bare header", async ({ page }) => {
  // A plain ```sh fence stands in for an agent run: the placeholder is for
  // every quiet command, and `claude -p` prints nothing until it is done.
  // The harness only records a run (harness.tsx runInline), and this spec
  // never pushes output through its runOutput hook, so the panel holds
  // "running, no output yet".
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
