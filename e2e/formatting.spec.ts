// The Markdown formatting chords (editor/formatting.ts): ⌘B/⌘I toggle the
// markers, ⌘K wraps a link. formatting.test.ts covers those decisions in the
// pure core; these specs cover the rest: the chords as a CodeMirror keymap,
// and the rendering under live preview. raw() below reads the document
// through the harness clipboard, which hands back what ⌘C copied: the raw
// text, markers included (testing.md §5).
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
});

// The document as written: select all, then copy through the harness
// clipboard. The selection is left in place. The second ⌘B in the first test
// needs that: a selection that grabbed the markers has to toggle the same as
// one inside them.
async function raw(page: import("@playwright/test").Page): Promise<string> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  return page.evaluate(() => window.__harness.clipboard());
}

test("⌘B wraps the selection in ** and ⌘B again unwraps it", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("bold me");
  await page.keyboard.press("Shift+Meta+ArrowLeft"); // select the line
  await page.keyboard.press("Meta+b");
  expect(await raw(page)).toBe("**bold me**");

  // raw() left the whole doc selected, markers included. ⌘B still toggles.
  await page.keyboard.press("Meta+b");
  expect(await raw(page)).toBe("bold me");
});

test("⌘I with a bare caret italicizes the word at the caret", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("make it italic");
  await page.keyboard.press("Meta+i");
  expect(await raw(page)).toBe("make it *italic*");
});

test("bolded text renders bold under live preview, markers concealed", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("bold me");
  await page.keyboard.press("Shift+Meta+ArrowLeft");
  await page.keyboard.press("Meta+b");
  // ⌘↓ leaves the caret at the end of the line, still touching the strong
  // element, so the markers stay revealed. Enter gives the caret a second
  // line to sit on, and line 1 then conceals down to the styled text.
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  const line = page.locator(".cm-line").first();
  await expect(line).toHaveText("bold me");
  await expect(line.locator("span", { hasText: "bold me" }).first()).toHaveCSS(
    "font-weight",
    "700",
  );
});

test("⌘K on a selected URL makes it the destination, caret in the label", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("https://example.com");
  await page.keyboard.press("Shift+Meta+ArrowLeft");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("docs"); // the caret is already between the brackets
  expect(await raw(page)).toBe("[docs](https://example.com)");
});

test("⌘K on a word makes it the label, caret in the destination", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("see docs");
  await page.keyboard.press("Meta+k"); // caret sits in "docs"
  await page.keyboard.type("https://x.dev"); // the caret is already in the parens
  expect(await raw(page)).toBe("see [docs](https://x.dev)");
});
