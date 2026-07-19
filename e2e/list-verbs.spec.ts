// The list-row grammar (interactions.md §1 R5/R6, §2 bare keys), driven
// end-to-end in headless WebKit: click focuses a row, bare keys act on the
// focused row and ONLY there, destructive-irreversible actions confirm with
// focus on Cancel. This is the layer the unit tests cannot see — the
// click-focus bug lived exactly here — so these specs assert on real focus
// and real DOM, never on internals.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const trashRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="trash"]', { hasText: title });

// Which row holds focus, by its data-list-row key (null when focus is
// elsewhere) — the ground truth the row verbs dispatch on.
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
    // Focus must survive the note opening: opening shows the note, clicking
    // the editor is the gesture that says you want to type (R5).
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
    // Irreversible, so the safe answer is the default (interactions.md §4).
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trashRow(page, "Older")).toBeVisible(); // nothing deleted
  });

  test("confirming permanently deletes; the emptied section disappears", async ({ page }) => {
    await expand(page);
    await trashRow(page, "Older").click();
    await page.keyboard.press("d");
    // Scoped to the dialog: the hover trash-can advertises the same name.
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete Permanently" }).click();
    await expect(trashRow(page, "Older")).toHaveCount(0);
    // The last item is gone, so the whole section hides: an empty trash has
    // nothing to discover.
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
