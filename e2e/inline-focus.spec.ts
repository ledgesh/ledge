// Who owns the keyboard while an inline run is live.
//
// A run that asks something ("Password:", "[y/N]") used to be unanswerable
// without a click: focus stayed in the prose, so the answer was typed into the
// note (a password written to disk, in the worst case). A run now claims the
// keyboard when it first speaks — but only if the user is still sitting where
// they pressed ⌘↩, because the other half of the trade is that ⌘↩-then-keep-
// writing must not lose the sentence. These specs state both halves, plus the
// way back out.
//
// PTYs are inert here; `__harness.runOutput` pushes the first byte the way
// Bun's runEvent would, which is the only thing a run's focus behavior needs.
import { expect, test } from "@playwright/test";

const IN_TERMINAL = () => !!document.activeElement?.closest(".xterm");
const IN_EDITOR = () => !!document.activeElement?.classList.contains("cm-content");

// A scratch note holding one runnable block, run inline with the caret in it.
async function runBlock(page: import("@playwright/test").Page) {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Untitled\n\n```sh\nsudo ls\n```\n");
  await page.locator(".cm-line", { hasText: "sudo ls" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-output")).toBeVisible();
  const runs = await page.evaluate(() => window.__harness.inlineRuns());
  return runs[runs.length - 1].id;
}

test("a run takes the keyboard when it first speaks, and says so", async ({ page }) => {
  const id = await runBlock(page);
  // Nothing has been printed yet: the caret is still in the note, where the
  // user left it. A silent run must not move focus preemptively.
  expect(await page.evaluate(IN_EDITOR)).toBe(true);

  await page.evaluate((runId) => window.__harness.runOutput(runId, "Password:"), id);

  await expect.poll(() => page.evaluate(IN_TERMINAL)).toBe(true);
  // And the panel says whose keys these are, with the way out. Two elements,
  // because the way out is not the same sentence on a client with no keys: the
  // touch half of this is phone.spec.ts's.
  await expect(page.locator(".ledge-focus-hint")).toHaveText("typing here");
  await expect(page.locator(".ledge-focus-key")).toHaveText("· esc esc to exit");
  // And the control that stands in for those keys is not on a Mac, which has
  // them.
  await expect(page.locator(".ledge-term-leave")).toBeHidden();
});

test("a user who went back to writing keeps the keyboard", async ({ page }) => {
  const id = await runBlock(page);
  // The ⌘↩-and-keep-taking-notes flow: the caret has moved on, so the run's
  // claim lapses instead of swallowing the next sentence.
  // (The H1 renders concealed once the caret leaves it, so address it by
  // position rather than by its raw text.)
  await page.locator(".cm-line").first().click();
  await page.keyboard.type(" more prose");

  await page.evaluate((runId) => window.__harness.runOutput(runId, "building...\r\n"), id);
  await page.waitForTimeout(150);

  expect(await page.evaluate(IN_TERMINAL)).toBe(false);
  expect(await page.evaluate(IN_EDITOR)).toBe(true);
});

test("Escape twice hands the keyboard back to the note", async ({ page }) => {
  const id = await runBlock(page);
  await page.evaluate((runId) => window.__harness.runOutput(runId, "Password:"), id);
  await expect.poll(() => page.evaluate(IN_TERMINAL)).toBe(true);

  // One Escape belongs to whatever is running; the second one is the exit.
  await page.keyboard.press("Escape");
  expect(await page.evaluate(IN_TERMINAL)).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(IN_EDITOR)).toBe(true);
});

test("dismissing a focused run gives the keyboard back, not the void", async ({ page }) => {
  const id = await runBlock(page);
  await page.evaluate((runId) => window.__harness.runOutput(runId, "Password:"), id);
  await expect.poll(() => page.evaluate(IN_TERMINAL)).toBe(true);

  await page.locator(".ledge-close-wrap button").last().dispatchEvent("mousedown", { button: 0 });
  await expect(page.locator(".ledge-output")).toHaveCount(0);
  await expect.poll(() => page.evaluate(IN_EDITOR)).toBe(true);
});
