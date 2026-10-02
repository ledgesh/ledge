// About Ledge (components/AboutDialog.tsx, issue #11): a palette command on
// every client, showing the version line `ledge version` prints and the build
// of the server this window is on, with a Copy for a bug report. The harness
// plays the shell's appInfo answer and the connection's handshake build.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

const LINES = "Ledge 0.1.0 (stable, abcdefgh) on darwin arm64; bun 1.3.0\nServer: This Mac, ledge 0.1.0-harness";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("About Ledge shows the version line and the server's build, and Copy copies both", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+P");
  await page.getByPlaceholder("Run a command").fill("About");
  await expect(page.locator("[data-active]")).toContainText("About Ledge");
  await page.keyboard.press("Enter");

  const dialog = page.getByTestId("about-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Ledge 0.1.0");
  await expect(page.getByTestId("about-text")).toHaveText(LINES);

  await dialog.getByRole("button", { name: "Copy" }).click();
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => window.__harness.clipboard())).toBe(LINES);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
