// What a reconnect does to a panel that was left on "Running".
//
// The wire dropping does not pause anything: the run keeps going on the server
// and its events are pushed at a connection that is gone, and a push with
// nowhere to go is dropped rather than queued (bun/daemon.ts). So a client that
// comes back can be holding a panel for a run that finished while it was away,
// with a run button disabled for good behind it. Coming back is therefore also
// when it asks (bridge.ts reconcileRuns), and these state both answers.
//
// PTYs are inert here; `__harness.holdRuns` is the fake server's side of that
// question and `__harness.linkState` is the wire coming back.
import { expect, test } from "@playwright/test";

// A scratch note holding one runnable block, run inline with the caret in it.
async function runBlock(page: import("@playwright/test").Page) {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Untitled\n\n```sh\nsleep 30\n```\n");
  await page.locator(".cm-line", { hasText: "sleep 30" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-status")).toHaveText("Running");
  const runs = await page.evaluate(() => window.__harness.inlineRuns());
  return runs[runs.length - 1].id;
}

async function reconnect(page: import("@playwright/test").Page) {
  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await page.evaluate(() => window.__harness.linkState("live", ""));
}

test("a panel the server is no longer running is closed out on reconnect", async ({ page }) => {
  const id = await runBlock(page);

  await reconnect(page);

  // Claimed by id: the panel is the only record this side has of the run.
  await expect.poll(() => page.evaluate(() => window.__harness.runClaims())).toContainEqual([id]);
  // Unconfirmed, so it ends with no status — which is honest, because what
  // happened to it happened while nobody was listening.
  await expect(page.locator(".ledge-status")).toHaveText("Session ended");
  await expect(page.locator(".ledge-dot-error")).toBeVisible();

  // And the block is runnable again. One live run per block is what disables
  // it, so a panel stuck on "Running" is a run button dead for the session.
  await page.locator(".cm-line", { hasText: "sleep 30" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await page.evaluate(() => window.__harness.inlineRuns())).length).toBe(2);
});

test("a run the server confirms is left alone", async ({ page }) => {
  const id = await runBlock(page);
  await page.evaluate((runId) => window.__harness.holdRuns([runId]), id);

  await reconnect(page);

  await expect.poll(() => page.evaluate(() => window.__harness.runClaims())).toContainEqual([id]);
  await expect(page.locator(".ledge-status")).toHaveText("Running");
  // Still the one live run this block is allowed, so ⌘↩ is refused rather
  // than starting a second one nothing would ever close.
  await page.locator(".cm-line", { hasText: "sleep 30" }).click();
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(100);
  expect((await page.evaluate(() => window.__harness.inlineRuns())).length).toBe(1);
});

test("a client with no panels claims nothing", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();

  await reconnect(page);

  // The empty claim is sent rather than skipped: it is what tells a server
  // that everything it is running belongs to a page that no longer exists.
  await expect.poll(() => page.evaluate(() => window.__harness.runClaims())).toContainEqual([]);
});
