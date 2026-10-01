// A server whose settings.jsonc changed after it read the file (architecture.md
// §6). The window boots on the old snapshot, so it has to say so once:
// `?staleSettings=1` makes the harness answer like such a server.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

test("a window on out-of-date settings says the change is not applied yet", async ({ page }) => {
  await page.goto("/harness.html?staleSettings=1");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(page.getByText("The server's settings changed after it started")).toBeVisible();
});

test("a window on current settings says nothing about them", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(page.getByText("The server's settings changed after it started")).toHaveCount(0);
});
