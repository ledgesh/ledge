// The Markdown formatting chords (editor/formatting.ts): ⌘B/⌘I toggle the
// markers, ⌘K wraps a link. The toggle decisions live in the pure core
// (formatting.test.ts); these are the user-observable halves — the chords
// fire inside CodeMirror, the document carries the raw markers (read back
// through the clipboard seam, the one sanctioned window.__harness surface for
// text with no visible raw form under live preview), and concealment renders
// the result.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
});

// The document as written: select all, copy through the harness clipboard.
// Leaves everything selected, which the round-trip tests use deliberately —
// a selection that grabbed the markers must toggle the same as one inside.
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

  // raw() left the whole doc — markers included — selected; ⌘B still toggles.
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
  // Caret away conceals the markers; the styled content is what remains.
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
