// Tags in the editor (editor/tags.ts + livePreview.ts + frontmatter.ts):
// inline #tags render as pills always (nothing conceals), a fenced one stays
// plain text, clicking a rendered tag lands in the Tags panel drilled into
// it, the `#` picker offers the workspace's own tags, and the frontmatter
// tags: line's tokens style like the profile name. Real WebKit because the
// pill styling, the hotspot click, and the popup are exactly what unit tests
// cannot see (docs/testing.md §5).
import { expect, test, type Locator, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// A visible completion popup is not yet an accepting one — the wikilinks
// spec's guard, for the same two Enter-swallowing windows (the disabled
// re-query state, and interactionDelay after opening). See wikilinks.spec.ts
// for the full story.
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

  // The tag pill is there even while the caret shares the note — emitted
  // always; only its clickability varies with touch.
  const pill = page.locator(".ledge-hashtag", { hasText: "#work" });
  await expect(pill).toBeVisible();
  await expect(page.locator(".ledge-hashtag", { hasText: "#fenced" })).toHaveCount(0);
});

test("clicking a rendered #tag lands in the Tags panel, drilled in", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Clicky\n\nsee #roadmap soon\nlast line");
  // Park the caret away from the tag so it renders live (untouched).
  await page.keyboard.press("Meta+ArrowDown");

  // The rendered tag gets the same WKWebView-proof hotspot as a rendered
  // link — the hotspot owns the click (the wikilinks spec's move).
  const hotspot = page.locator('.ledge-hotspot[title="Click to show tagged notes"]');
  await expect(hotspot).toHaveCount(1);
  await hotspot.click();

  await expect(page.locator("aside", { hasText: "#roadmap" })).toBeVisible();
  await expect(
    page.locator('[data-target-kind="tagnote"]', { hasText: "Clicky" }),
  ).toBeVisible();
});

test("# pops the tag picker with the workspace's tags; accepting completes", async ({ page }) => {
  // Seed the vocabulary: a note bearing #ledge, saved so the directory scan
  // (and the App-side vocabulary refresh) sees it.
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
  for (const line of ["---", "tags: work, home", "---", "# Declared"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await expect(page.locator(".ledge-fm-tag", { hasText: "work" })).toBeVisible();
  await expect(page.locator(".ledge-fm-tag", { hasText: "home" })).toBeVisible();
});
