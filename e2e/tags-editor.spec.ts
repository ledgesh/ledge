// Tags in the editor (editor/tags.ts, livePreview.ts, frontmatter.ts). An
// inline #tag renders as a pill, and a fenced one stays plain. Clicking a pill
// opens the Tags panel drilled in. `#` completes the workspace's tags, and
// frontmatter `tags:` tokens style like the profile name. Runs in real WebKit:
// unit tests cannot see pills, hotspot clicks, or the popup (testing.md §5).
import { expect, test, type Locator, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// A visible completion popup does not always accept Enter, which then inserts
// a newline. Two windows do that: a keystroke's re-query is in flight (the
// popup carries the cm-tooltip-autocomplete-disabled class), or the popup
// opened less than 75ms ago (interactionDelay). Waiting out the class and then
// 100ms clears both, and wikilinks.spec.ts works through the timing.
const completionAcceptReady = async (page: Page, popup: Locator) => {
  await expect(popup).not.toHaveClass(/cm-tooltip-autocomplete-disabled/);
  await page.waitForTimeout(100);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("an inline #tag styles as a pill; a fenced one stays plain", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Pills\n\nreal #work here\n```\n#fenced\n```\n");

  // livePreview.ts always emits the .ledge-hashtag span. A selection touching
  // the tag only drops the live class, the title, and the data-tag the
  // hotspot layer clicks through (liveTag vs TAG_PLAIN).
  const pill = page.locator(".ledge-hashtag", { hasText: "#work" });
  await expect(pill).toBeVisible();
  await expect(page.locator(".ledge-hashtag", { hasText: "#fenced" })).toHaveCount(0);
});

test("clicking a rendered #tag lands in the Tags panel, drilled in", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Clicky\n\nsee #roadmap soon\nlast line");
  // The trailing "last line" leaves the caret below the tag, so the selection
  // does not touch it and livePreview.ts renders the live, clickable span.
  // Meta+ArrowDown is cursorDocEnd, where the caret already is.
  await page.keyboard.press("Meta+ArrowDown");

  // The rendered tag gets the same WKWebView-proof hotspot as a rendered link
  // (wikilinks.spec.ts). The WebView does not reliably honour `cursor` inside
  // the editor, so livePreview.ts floats an invisible div over each rendered
  // mark, and that div takes the click.
  const hotspot = page.locator('.ledge-hotspot[title="Click to show tagged notes"]');
  await expect(hotspot).toHaveCount(1);
  await hotspot.click();

  await expect(page.locator("aside", { hasText: "#roadmap" })).toBeVisible();
  await expect(
    page.locator('[data-target-kind="tagnote"]', { hasText: "Clicky" }),
  ).toBeVisible();
});

test("# pops the tag picker with the workspace's tags; accepting completes", async ({ page }) => {
  // Seed the vocabulary with a note carrying #ledge. Waiting for its row waits
  // out the save and the note-list update, and App.tsx refetches the tag scan
  // the picker reads whenever that list changes.
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Seed\n\ncarry #ledge here");
  await expect(noteRow(page, "Seed")).toBeVisible();

  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Fresh\n\nabout #le");

  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup).toBeVisible();
  await expect(popup.locator("li", { hasText: "#ledge" })).toBeVisible();
  await completionAcceptReady(page, popup);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line", { hasText: "about #ledge" })).toBeVisible();
});

test("frontmatter tags: tokens style like the profile name", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  // A new note opens with the caret on its title and "Untitled" selected
  // (editorPool.ts). Meta+ArrowUp is cursorDocStart, so the frontmatter is
  // typed above the title instead of replacing it.
  await page.keyboard.press("Meta+ArrowUp");
  for (const line of ["---", "tags: work, home", "---", "# Declared"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await expect(page.locator(".ledge-fm-tag", { hasText: "work" })).toBeVisible();
  await expect(page.locator(".ledge-fm-tag", { hasText: "home" })).toBeVisible();
});
