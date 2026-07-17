// "Run in terminal" from a block in an UNFOCUSED pane. The block's buttons live
// in the body-parented overlay layer (blocks.ts), so clicking one never hits the
// pane's focus-on-mousedown handler — but the drawer always shows the focused
// pane's note. The run must therefore focus the block's own pane first, or the
// drawer opens on some other note's shell while the paste runs invisibly in the
// right one (App.tsx runInTerminal). PTYs are inert in the harness; what these
// specs assert is the ROUTING: the session the drawer attaches is the session
// the block's code was pasted into.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  // Pane 1: a fresh scratch note, which ships with a ```sh block.
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line", { hasText: 'echo "ready"' })).toBeVisible();
  // Pane 2: split right (focused), then replace ITS scratch block with prose,
  // so exactly one terminal button exists — pane 1's.
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

  await page.locator('[data-act="term"]').dispatchEvent("mousedown", { button: 0 });

  // The drawer opened AND focus moved to the block's pane: the prose pane is
  // now the dimmed one.
  await expect(page.locator(".xterm")).toBeVisible();
  await expect(
    page.locator(".opacity-45 .cm-content", { hasText: "plain prose" }),
  ).toBeVisible();

  // The paste landed once the drawer's terminal was ready, in the SAME session
  // the drawer attached — the shell on screen, not an invisible one.
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
