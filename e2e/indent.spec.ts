// Tab indentation in the editor (setup.ts's indentKeymap). Ledge binds Tab
// because WKWebView moves focus out of the editor when nothing claims the key.
// Indenting a list item carries its marker along, which nests the item; in
// prose Tab is the ordinary indent. Runs in real WebKit: a fake DOM has no
// default focus move for Tab to override (testing.md §5).
import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await page.keyboard.press("Meta+a");
});

// Returns the note's Markdown source: select all, copy, read the harness
// clipboard. ⌘C slices the document, so this is the text as typed, not what
// live preview draws on screen.
async function raw(page: Page): Promise<string> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  const text = await page.evaluate(() => window.__harness.clipboard());
  await page.keyboard.press("ArrowRight"); // collapse the selection so the next keystroke appends
  return text;
}

// The guard wikilinks.spec.ts explains above its own completionAcceptReady.
// Tab is bound twice here (editor/setup.ts), so a declined acceptCompletion
// falls through to indentMore and indents the line instead of taking the row.
const completionAcceptReady = async (page: Page, popup: Locator) => {
  await expect(popup).not.toHaveClass(/cm-tooltip-autocomplete-disabled/);
  await page.waitForTimeout(100);
};

test("Tab keeps the caret in the editor instead of walking focus out", async ({ page }) => {
  await page.keyboard.type("text");
  await page.keyboard.press("Tab");
  await expect(page.locator(".cm-editor.cm-focused")).toHaveCount(1);
  await expect(page.locator(".cm-cursorLayer .cm-cursor")).not.toHaveCount(0);
});

test("Tab nests a list item, ⇧Tab lifts it back out", async ({ page }) => {
  await page.keyboard.type("- one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Tab");
  expect(await raw(page)).toBe("- one\n  - two");

  await page.keyboard.press("Shift+Tab");
  expect(await raw(page)).toBe("- one\n- two");
});

test("Tab indents a checkbox item whole, marker and all", async ({ page }) => {
  await page.keyboard.type("- [ ] task");
  await page.keyboard.press("Tab");
  expect(await raw(page)).toBe("  - [ ] task");
});

test("Tab in prose indents the line the caret is on", async ({ page }) => {
  await page.keyboard.type("just words");
  await page.keyboard.press("Tab");
  expect(await raw(page)).toBe("  just words");
});

test("Tab indents every line a selection touches", async ({ page }) => {
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Tab");
  expect(await raw(page)).toBe("  one\n  two");
});

test("Tab takes the picker's highlighted row while one is open", async ({ page }) => {
  await page.keyboard.type("see [[Al");
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup.locator("li")).toHaveCount(1);
  await completionAcceptReady(page, popup);
  await page.keyboard.press("Tab");
  await expect(page.locator(".cm-line").first()).toHaveText("see [[Alpha]]");
});
