// The tab strip when tabs overflow the pane: it scrolls with no visible
// scrollbar, so switching tabs must be what keeps the active one on screen —
// a ⌃N / ⌃Tab jump to a clipped tab may never select something invisible.
// A mouse wheel over the strip scrolls it sideways (a wheel has no vertical
// axis to spend there).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// Enough ⌘N tabs to overflow the strip at the default viewport width. The
// count is relative: the harness may boot with tabs already open.
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
  // The just-created tab is active and on screen; the first has been pushed
  // off the left edge rather than every tab being crushed to fit.
  await expect(tabs.last()).toBeInViewport();
  await expect(tabs.first()).not.toBeInViewport();
});

test("switching to a clipped tab scrolls it into view", async ({ page }) => {
  await openManyTabs(page, 17);
  const tabs = page.locator("[data-tab]");
  await page.keyboard.press("Control+1");
  await expect(tabs.first()).toBeInViewport();
  await expect(tabs.last()).not.toBeInViewport();
  // And back: ⌃Tab cycles from tab 1; the far end is reachable the same way.
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
  // The just-created tab is active at the far right: tabs clip off the left.
  await expect(strip).toHaveClass(/ledge-tabstrip-clip-l/);
  // Jump to the first tab: the strip is at its start, so only the right clips.
  await page.keyboard.press("Control+1");
  await expect(strip).toHaveClass(/ledge-tabstrip-clip-r/);
  await expect(strip).not.toHaveClass(/ledge-tabstrip-clip-l/);
  // Wheel partway in: now both edges hide tabs.
  const box = await strip.boundingBox();
  if (!box) throw new Error("strip has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect(strip).toHaveClass(/ledge-tabstrip-clip-l/);
  await expect(strip).toHaveClass(/ledge-tabstrip-clip-r/);
});
