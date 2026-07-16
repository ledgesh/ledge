// App-level chrome: the two overlay modes (⌘P notes, ⇧⌘P commands, `>` to
// cross between them), ⌘⌫ as the chord form of delete, Empty Trash's
// confirmation, and the modal-suppression rule (§6: while a layer is open,
// the window dispatcher is silent).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("⌘P quick-open filters notes and Enter opens the pick", async ({ page }) => {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("gam");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content").first()).toContainText("gamma body");
});

test("⇧⌘P opens the command palette and Enter runs the pick", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+P");
  await page.keyboard.type("toggle sidebar");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Workspaces")).toBeHidden();
});

test("`>` as the first character crosses from notes to commands", async ({ page }) => {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type(">toggle sidebar");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Workspaces")).toBeHidden();
});

test("⌘⌫ on a focused note row deletes that note, with Undo", async ({ page }) => {
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Meta+Backspace");
  await expect(noteRow(page, "Alpha")).toHaveCount(0);
  await expect(page.getByText("Deleted “Alpha”")).toBeVisible();
});

test("Empty Trash confirms, focused on Cancel, and empties on confirm", async ({ page }) => {
  await page.getByRole("button", { name: /^Trash/ }).click();
  await page.getByRole("button", { name: "Empty" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Empty the trash?");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Empty Trash" }).click();
  await expect(page.getByRole("button", { name: /^Trash/ })).toHaveCount(0);
});

test("an open context menu suppresses the dispatcher; Escape closes only the menu", async ({ page }) => {
  await noteRow(page, "Beta").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Delete/ })).toBeVisible();
  // A bare `d` with the menu open must not fire the row verb underneath.
  await page.keyboard.press("d");
  await expect(noteRow(page, "Beta")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(noteRow(page, "Beta")).toBeVisible(); // Escape addressed the menu, nothing else
});
