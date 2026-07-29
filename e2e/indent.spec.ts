// Tab indentation in the editor (setup.ts's indentKeymap). Ledge claims Tab
// because WKWebView's default for an unclaimed one is to move focus OUT of the
// editor, which in a notebook you type Markdown into is never what it meant.
// On a list item indenting the line is what nests it; in prose it is the
// ordinary indent. Real WebKit because the thing being fixed IS the browser's
// default handling of the key.
import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await page.keyboard.press("Meta+a");
});

// The document as written: select all, copy through the harness clipboard.
async function raw(page: Page): Promise<string> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  const text = await page.evaluate(() => window.__harness.clipboard());
  await page.keyboard.press("ArrowRight"); // collapse to the end, ready to type on
  return text;
}

// wikilinks.spec.ts's guard, verbatim: the popup ignores its accept key while
// young and while the -disabled class is up.
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
