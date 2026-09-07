// These specs drive the list-row grammar in headless WebKit (interactions.md
// §1 R5/R6, §2 bare keys). A click focuses a row. Bare keys act on the focused
// row and nowhere else. Destructive-irreversible actions confirm with focus on
// Cancel. Unit tests cannot see this layer, which is where the click-focus bug
// was. These specs assert on real focus and real DOM, not on internals.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const trashRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="trash"]', { hasText: title });

// The focused row's data-list-row key, or null when focus is elsewhere. The
// row verbs act on whichever row holds focus.
const focusedRowKey = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.["listRow"] ?? null);

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test.describe("note rows", () => {
  test("clicking a row focuses it, opens the note, and does NOT hand focus to the editor", async ({ page }) => {
    await noteRow(page, "Beta").click();
    await expect(page.locator(".cm-content").first()).toContainText("beta body");
    // Opening the note leaves focus on the row. Clicking the editor moves
    // focus into it (interactions.md §1 R5).
    expect(await focusedRowKey(page)).toContain("beta.md");
  });

  test("arrow keys move the focused row; Enter opens it", async ({ page }) => {
    await noteRow(page, "Alpha").click();
    await page.keyboard.press("ArrowDown");
    expect(await focusedRowKey(page)).toContain("beta.md");
    await page.keyboard.press("Enter");
    await expect(page.locator(".cm-content").first()).toContainText("beta body");
  });

  test("navigation clamps at the edges and Home/End jump to them", async ({ page }) => {
    await noteRow(page, "Alpha").click();
    await page.keyboard.press("ArrowUp"); // clamped, not wrapped: the top row stays
    expect(await focusedRowKey(page)).toContain("alpha.md");
    await page.keyboard.press("End");
    expect(await focusedRowKey(page)).toContain("gamma.md");
    await page.keyboard.press("ArrowDown"); // clamped at the bottom too
    expect(await focusedRowKey(page)).toContain("gamma.md");
    await page.keyboard.press("Home");
    expect(await focusedRowKey(page)).toContain("alpha.md");
  });

  test("`d` trashes the focused note and offers Undo; Undo brings it back", async ({ page }) => {
    await noteRow(page, "Beta").click();
    await page.keyboard.press("d");
    await expect(noteRow(page, "Beta")).toHaveCount(0);
    await expect(page.getByText("Deleted “Beta”")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(noteRow(page, "Beta")).toBeVisible();
  });

  test("bare keys are typing everywhere but a focused row: `d` in the editor types a d", async ({ page }) => {
    await noteRow(page, "Alpha").click();
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await page.keyboard.press("Meta+ArrowDown"); // caret to document end, wherever the click landed
    await page.keyboard.type("d");
    await expect(editor).toContainText("alpha bodyd");
    await expect(noteRow(page, "Alpha")).toBeVisible(); // nothing was deleted
    await expect(noteRow(page, "Beta")).toBeVisible();
  });

  test("`c` copies the focused row's path", async ({ page }) => {
    await noteRow(page, "Gamma").click();
    await page.keyboard.press("c");
    expect(await page.evaluate(() => window.__harness.clipboard())).toBe("/harness/scratch/gamma.md");
  });
});

test.describe("trash rows", () => {
  const expand = async (page: Page) => {
    await page.getByRole("button", { name: /^Trash/ }).click();
    await expect(trashRow(page, "Older")).toBeVisible();
  };

  test("`d` opens the permanent-delete confirm, focused on Cancel; Escape backs out", async ({ page }) => {
    await expand(page);
    await trashRow(page, "Older").click();
    await page.keyboard.press("d");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Delete “Older” permanently?");
    // The dialog opens with Cancel focused, not Delete Permanently, because
    // the delete is irreversible (interactions.md §4).
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trashRow(page, "Older")).toBeVisible(); // nothing deleted
  });

  test("confirming permanently deletes; the emptied section disappears", async ({ page }) => {
    await expand(page);
    await trashRow(page, "Older").click();
    await page.keyboard.press("d");
    // Scoped to the dialog. Playwright matches an accessible name by
    // case-insensitive substring, and the hover trash-can's name
    // ("Delete Permanently… (D)") contains this one too.
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete Permanently" }).click();
    await expect(trashRow(page, "Older")).toHaveCount(0);
    // The last item is gone, so the whole Trash section stops rendering.
    await expect(page.getByRole("button", { name: /^Trash/ })).toHaveCount(0);
  });

  test("the hover trash-can opens the same confirm, never an unconfirmed unlink", async ({ page }) => {
    await expand(page);
    await trashRow(page, "Older").hover();
    await trashRow(page, "Older").getByRole("button", { name: /Delete Permanently/ }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Delete “Older” permanently?");
  });

  test("`r` restores the focused trashed note into the note list", async ({ page }) => {
    await expand(page);
    await trashRow(page, "Older").click();
    await page.keyboard.press("r");
    await expect(noteRow(page, "Older")).toBeVisible();
  });

  test("note verbs refuse a trash row: Enter on a trashed note opens nothing", async ({ page }) => {
    await expand(page);
    await trashRow(page, "Older").click();
    await page.keyboard.press("Enter");
    await expect(page.locator(".cm-content").first()).not.toContainText("once deleted");
    await expect(trashRow(page, "Older")).toBeVisible();
  });
});
