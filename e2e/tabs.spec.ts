// The tab strip when tabs overflow the pane (workspace/PaneTree.tsx). The
// strip's scrollbar is hidden, so it scrolls the active tab into view on every
// switch. Without that, ⌃1…9 and ⌃Tab could select a tab that is scrolled out
// of sight. A mouse wheel over the strip scrolls it sideways, since the strip
// has no vertical axis.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// Opens Alpha, then presses ⌘N `count` times. The harness boots with a tab
// already open, and opening Alpha can add another, so the assertion counts up
// from the tabs that are there. The caller picks a count big enough to
// overflow the strip (the tests below pass 17), and nothing here checks that
// it overflowed.
const openManyTabs = async (page: Page, count: number) => {
  await noteRow(page, "Alpha").click();
  const before = await page.locator("[data-tab]").count();
  for (let i = 0; i < count; i++) await page.keyboard.press("Meta+n");
  await expect(page.locator("[data-tab]")).toHaveCount(before + count);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("overflowing tabs clip instead of shrinking, and the newest stays visible", async ({ page }) => {
  await openManyTabs(page, 17);
  const tabs = page.locator("[data-tab]");
  // The just-created tab is active and on screen. The first tab is pushed off
  // the left edge instead of every tab shrinking to fit.
  await expect(tabs.last()).toBeInViewport();
  await expect(tabs.first()).not.toBeInViewport();
});

test("switching to a clipped tab scrolls it into view", async ({ page }) => {
  await openManyTabs(page, 17);
  const tabs = page.locator("[data-tab]");
  await page.keyboard.press("Control+1");
  await expect(tabs.first()).toBeInViewport();
  await expect(tabs.last()).not.toBeInViewport();
  // The far end scrolls into view the same way. ⌃⇧Tab cycles backwards from
  // tab 1.
  await page.keyboard.press("Control+Shift+Tab"); // wraps to the last tab
  await expect(tabs.last()).toBeInViewport();
  await expect(tabs.first()).not.toBeInViewport();
});

test("a mouse wheel over the strip scrolls the tabs sideways", async ({ page }) => {
  await openManyTabs(page, 17);
  const tabs = page.locator("[data-tab]");
  await page.keyboard.press("Control+1");
  await expect(tabs.first()).toBeInViewport();
  const strip = await tabs.first().boundingBox();
  if (!strip) throw new Error("first tab has no box");
  await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2);
  await page.mouse.wheel(0, 600);
  await expect(tabs.first()).not.toBeInViewport();
});

test("the fade masks track which edge is clipping", async ({ page }) => {
  await openManyTabs(page, 17);
  const strip = page.locator(".ledge-tabstrip");
  // The just-created tab is active at the far right, so the strip hides tabs
  // on its left edge.
  await expect(strip).toHaveClass(/ledge-tabstrip-clip-l/);
  // ⌃1 jumps to the first tab. That scrolls the strip back to its start, so
  // only its right edge hides tabs.
  await page.keyboard.press("Control+1");
  await expect(strip).toHaveClass(/ledge-tabstrip-clip-r/);
  await expect(strip).not.toHaveClass(/ledge-tabstrip-clip-l/);
  // A wheel tick moves the strip partway along, where both edges hide tabs.
  const box = await strip.boundingBox();
  if (!box) throw new Error("strip has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect(strip).toHaveClass(/ledge-tabstrip-clip-l/);
  await expect(strip).toHaveClass(/ledge-tabstrip-clip-r/);
});
