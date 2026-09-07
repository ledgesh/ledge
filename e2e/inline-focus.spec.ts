// Who owns the keyboard while an inline run is live.
//
// A run claims the keyboard when it first prints. The claim lapses if the
// editor has lost focus or the caret has moved since ⌘↩ (editor/blocks.ts,
// interactions.md §6a), so ⌘↩ followed by more writing keeps the keyboard in
// the note.
//
// PTYs are inert here (testing.md §5). `__harness.runOutput` pushes the first
// byte the way Bun's runEvent would, and the claim is honored on that byte.
import { expect, test } from "@playwright/test";

const IN_TERMINAL = () => !!document.activeElement?.closest(".xterm");
const IN_EDITOR = () => !!document.activeElement?.classList.contains("cm-content");

// Makes a scratch note with one runnable block, puts the caret in the block,
// runs it with ⌘↩, and returns the run's id.
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
  // user left it. A run that has not printed anything must not move the focus
  // yet.
  expect(await page.evaluate(IN_EDITOR)).toBe(true);

  await page.evaluate((runId) => window.__harness.runOutput(runId, "Password:"), id);

  await expect.poll(() => page.evaluate(IN_TERMINAL)).toBe(true);
  // The panel names the state and the way out, in two elements. A touch
  // client hides both and shows a button in their place. phone.spec.ts covers
  // that side.
  await expect(page.locator(".ledge-focus-hint")).toHaveText("typing here");
  await expect(page.locator(".ledge-focus-key")).toHaveText("· esc esc to exit");
  // The button that stands in for that pair shows on a touch client while the
  // panel holds focus (index.css, `@media (hover: none)`).
  await expect(page.locator(".ledge-term-leave")).toBeHidden();
});

test("a user who went back to writing keeps the keyboard", async ({ page }) => {
  const id = await runBlock(page);
  // The case here is ⌘↩ and then carrying on with the note. The caret has
  // moved, so the run's claim lapses instead of swallowing the next sentence.
  // The H1 renders concealed once the caret leaves it, so address that line by
  // position rather than by its raw text.
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

  // The program gets the first Escape. The second one leaves, and only if it
  // lands within ESC_EXIT_MS of the first (600ms, editor/inlineTerm.ts). The
  // page.evaluate between the two presses fits in that budget. A wait, a poll
  // or a screenshot added here would not.
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
