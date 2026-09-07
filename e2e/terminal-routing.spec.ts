// "Run in terminal" from a block in an unfocused pane. The block's buttons sit
// in the body-parented overlay layer (blocks.ts), so a click never focuses its
// pane. App.tsx runInTerminal selects the block's tab first. The comment there
// says why. PTYs are inert in the harness, so these specs check that the drawer
// attaches the shell the code was pasted into.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  // Pane 1 gets a fresh scratch note with a heading and the ```sh block to run.
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText('# Untitled\n\n```sh\necho "ready"\n```\n');
  await expect(page.locator(".cm-line", { hasText: 'echo "ready"' })).toBeVisible();
  // Pane 2 is the split to the right, and it holds focus. Filling it with prose
  // leaves one terminal button in the DOM, on pane 1's block.
  await page.keyboard.press("Meta+d");
  await expect(page.locator(".ledge-tabstrip")).toHaveCount(2);
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("plain prose, no blocks");
  await expect(page.locator('[data-act="term"]')).toHaveCount(1);
});

test("the terminal button in an unfocused pane focuses that pane and runs there", async ({ page }) => {
  // Pane 2 holds focus (it was just typed in): pane 1's editor is the dimmed one.
  await expect(
    page.locator(".opacity-45 .cm-content", { hasText: 'echo "ready"' }),
  ).toBeVisible();

  // The button is unlit here: nothing hovers it, and pane 1's caret sits past
  // the block. index.css keeps an unlit group hidden and its buttons out of
  // hit-testing, so the spec dispatches mousedown instead of clicking.
  await page.locator('[data-act="term"]').dispatchEvent("mousedown", { button: 0 });

  // The drawer opened and focus moved to the block's pane, so the prose pane
  // is now the dimmed one.
  await expect(page.locator(".xterm")).toBeVisible();
  await expect(
    page.locator(".opacity-45 .cm-content", { hasText: "plain prose" }),
  ).toBeVisible();

  // The paste waited for the drawer's terminal to be ready. It went to the
  // session the drawer attached, which is the shell on screen and not a
  // hidden one.
  await expect.poll(() => page.evaluate(() => window.__harness.termPastes())).toHaveLength(1);
  const { paste, attaches } = await page.evaluate(() => ({
    paste: window.__harness.termPastes()[0],
    attaches: window.__harness.termAttaches(),
  }));
  expect(paste.text).toContain('echo "ready"');
  expect(attaches[attaches.length - 1].sessionId).toBe(paste.sessionId);
});

test("the terminal button in the focused pane still routes to its own shell", async ({ page }) => {
  // Refocus pane 1 by clicking into its editor, then run its block.
  await page.locator(".cm-line", { hasText: 'echo "ready"' }).click();
  await page.locator('[data-act="term"]').dispatchEvent("mousedown", { button: 0 });

  await expect(page.locator(".xterm")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__harness.termPastes())).toHaveLength(1);
  const { paste, attaches } = await page.evaluate(() => ({
    paste: window.__harness.termPastes()[0],
    attaches: window.__harness.termAttaches(),
  }));
  expect(paste.text).toContain('echo "ready"');
  expect(attaches[attaches.length - 1].sessionId).toBe(paste.sessionId);
});
