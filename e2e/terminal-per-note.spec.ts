// The terminal drawer opens and closes per note (interactions.md §3, Toggle
// Terminal). App.tsx keeps the set of notes whose drawer is open, and the
// drawer shows while the focused note is in it. So opening it on one note
// leaves another note's closed, and closing it on one leaves another's open.
import { expect, test, type Page } from "@playwright/test";

const tab = (page: Page, title: string | RegExp) => page.locator("[data-tab]", { hasText: title });
const drawer = (page: Page) => page.locator(".xterm");
const toggle = (page: Page) => page.getByTitle("Toggle Terminal", { exact: false });

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.locator('[data-target-kind="note"]', { hasText: "Alpha" }).click();
  await expect(tab(page, "Alpha")).toBeVisible();
});

test("a drawer opened on one note does not open on another", async ({ page }) => {
  await toggle(page).click();
  await expect(drawer(page)).toBeVisible();

  await page.keyboard.press("Meta+n");
  await expect(tab(page, /Untitled/)).toHaveClass(/bg-background/);
  await expect(drawer(page)).toHaveCount(0);

  await tab(page, "Alpha").click();
  await expect(drawer(page)).toBeVisible();
});

test("closing a note's drawer leaves another note's open", async ({ page }) => {
  await toggle(page).click();
  await expect(drawer(page)).toBeVisible();

  await page.keyboard.press("Meta+n");
  await expect(drawer(page)).toHaveCount(0);
  await toggle(page).click();
  await expect(drawer(page)).toBeVisible();
  await toggle(page).click();
  await expect(drawer(page)).toHaveCount(0);

  await tab(page, "Alpha").click();
  await expect(drawer(page)).toBeVisible();
  await tab(page, /Untitled/).click();
  await expect(drawer(page)).toHaveCount(0);
});
