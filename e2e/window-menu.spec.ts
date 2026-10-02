// The menus in the window's header, on a desktop with no menu bar
// (commands/WindowMenu.tsx, interactions.md §10). `?mod=ctrl` is the harness's
// Linux desktop; the plain harness is a Mac, whose menus are AppKit's.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

const menus = (page: Page) => page.getByRole("navigation", { name: "Menus" });

test("a Mac draws no menus in the window", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(menus(page)).toHaveCount(0);
});

test.describe("on a desktop with no menu bar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?mod=ctrl");
    await expect(noteRow(page, "Alpha")).toBeVisible();
  });

  test("the header names the Mac's menus, less Window, which only held AppKit's roles", async ({ page }) => {
    await expect(menus(page).getByRole("button")).toHaveText(["Ledge", "File", "Edit", "Note", "View", "Help"]);
  });

  test("a title opens its menu, a press on it again closes it, and pointing at another title switches", async ({ page }) => {
    await menus(page).getByRole("button", { name: "File" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: /New Note/ }).first()).toBeVisible();

    await menus(page).getByRole("button", { name: "Edit" }).hover();
    await expect(menu.getByRole("menuitem", { name: /Find/ }).first()).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /New Note/ })).toHaveCount(0);

    await menus(page).getByRole("button", { name: "Edit" }).click();
    await expect(menu).toHaveCount(0);
  });

  test("Ledge > Quit Ledge asks the shell to quit, with its Ctrl+Q chip", async ({ page }) => {
    await menus(page).getByRole("button", { name: "Ledge" }).click();
    const quit = page.getByRole("menuitem", { name: /Quit Ledge/ });
    await expect(quit).toContainText("Ctrl+Q");
    await quit.click();
    expect(await page.evaluate(() => window.__harness.quitAsks())).toBe(1);
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("Ledge > About Ledge opens About Ledge", async ({ page }) => {
    await menus(page).getByRole("button", { name: "Ledge" }).click();
    await page.getByRole("menuitem", { name: "About Ledge" }).click();
    await expect(page.getByTestId("about-dialog")).toBeVisible();
  });

  test("Escape closes an open menu", async ({ page }) => {
    await menus(page).getByRole("button", { name: "View" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});
