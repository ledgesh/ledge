// The workspace strip is a row list, and interactions.md R6 gives every row
// kind the same grammar: Enter is the primary action (switch to it), ⌫ the
// destructive one (Delete Workspace, or Remove from Ledge on an attached
// folder), `r` the rename mnemonic. These specs cover that grammar and its two
// guards: the last workspace cannot go, and while the rename field is open the
// keys go into the text, not to the row verbs. The deleted workspaces' own
// Trash section and the Undo strip are covered at the end.
import { expect, test, type Page } from "@playwright/test";

const wsRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="workspace"]', { hasText: name });

const focusedRowKey = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.["listRow"] ?? null);

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(wsRow(page, "Scratch")).toBeVisible();
});

test("Enter on a focused row switches to that workspace", async ({ page }) => {
  // Creating a workspace selects it (workspace/store.tsx). The loose
  // /bg-accent/ below matches an unselected row too, for the reason the
  // anchored assertion gives, so it does not check the selection itself.
  await page.keyboard.press("Meta+Shift+N"); // second workspace
  await expect(wsRow(page, "Workspace 2")).toHaveClass(/bg-accent/);
  await wsRow(page, "Workspace 2").click();
  // ArrowUp moves the focused row to Scratch without selecting it. Selection
  // follows only from Enter, which runs workspace.open (commands/registry.ts;
  // interactions.md R7).
  await page.keyboard.press("ArrowUp");
  expect(await focusedRowKey(page)).not.toBeNull();
  // (^|\s) rather than a bare token: the unselected row still carries the
  // hover:bg-accent/50 utility, which a loose /bg-accent/ would match.
  await expect(wsRow(page, "Scratch")).not.toHaveClass(/(^|\s)bg-accent(\s|$)/);
  // Enter commits the switch.
  await page.keyboard.press("Enter");
  await expect(wsRow(page, "Scratch")).toHaveClass(/(^|\s)bg-accent(\s|$)/);
});

test("`r` begins an inline rename; committing it renames the workspace", async ({ page }) => {
  await wsRow(page, "Scratch").click();
  await page.keyboard.press("r");
  // Find the field by the row kind, not by the row's text. Once the field
  // opens the name is the input's value, so a hasText:"Scratch" row matches
  // nothing.
  const field = page.locator('[data-target-kind="workspace"]').getByRole("textbox");
  await expect(field).toBeVisible();
  await field.fill("Research");
  await page.keyboard.press("Enter");
  await expect(wsRow(page, "Research")).toBeVisible();
  await expect(wsRow(page, "Scratch")).toHaveCount(0);
});

test("keys typed in the rename field are typing, never row verbs", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N"); // a second workspace, so there is something to close
  await wsRow(page, "Workspace 2").click();
  await page.keyboard.press("r");
  const field = page.locator('[data-target-kind="workspace"]').getByRole("textbox");
  await expect(field).toBeVisible();
  // ⌫ inside the field edits text and `r` types an r. If either fired as a
  // row verb, this would close the workspace or start a second rename.
  // The field selects its whole value on mount (components/RenameField.tsx).
  // ArrowRight collapses that selection to the end, so ⌫ deletes one
  // character rather than the whole name.
  await field.press("ArrowRight");
  await field.press("Backspace");
  await field.press("r");
  await expect(field).toHaveValue("Workspace r");
  await expect(page.locator('[data-target-kind="workspace"]')).toHaveCount(2);
});

test("⌫ deletes the focused workspace", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N");
  await wsRow(page, "Workspace 2").click();
  await page.keyboard.press("Backspace");
  await expect(wsRow(page, "Workspace 2")).toHaveCount(0);
  // Scratch is the workspace left behind. The regex is the loose one, so this
  // shows the row is still there rather than that it is now selected.
  await expect(wsRow(page, "Scratch")).toHaveClass(/bg-accent/);
});

test("the last workspace refuses to go", async ({ page }) => {
  await wsRow(page, "Scratch").click();
  await page.keyboard.press("Backspace");
  await expect(wsRow(page, "Scratch")).toBeVisible();
});

test("a right-click on the strip's blank space opens the add menu", async ({ page }) => {
  // interactions.md R6b: the blank space below the last row is the strip
  // itself, so it answers with the menu the + row's chevron drops. The click
  // lands near the bottom of the list, well under the one Scratch row.
  const strip = page.getByTestId("workspace-strip");
  const box = (await strip.boundingBox())!;
  await strip.click({ button: "right", position: { x: 20, y: box.height - 8 } });
  await expect(page.getByRole("menuitem", { name: "New Workspace" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Attach Folder as Workspace…" }),
  ).toBeVisible();
  // And it is the strip's own menu, not a row's: the workspace verbs are absent.
  await expect(page.getByRole("menuitem", { name: "Rename Workspace…" })).toHaveCount(0);
});

test("a right-click on a row opens that row's menu, not the strip's", async ({ page }) => {
  // The row handler runs first and the strip's own handler asks whether a row
  // sits above the click (lib/useRowMenu.ts onBlankSpace), so one right-click
  // opens one menu.
  await wsRow(page, "Scratch").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Rename Workspace…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Attach Folder as Workspace…" })).toHaveCount(0);
});

const trashSection = (page: Page) => page.getByTestId("workspace-trash");
const trashedRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="trashedWorkspace"]', { hasText: name });

// A second workspace, with a note typed into it so there is something whose
// survival the specs below can check.
async function workspaceWithNote(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Shift+N");
  await expect(wsRow(page, "Workspace 2")).toBeVisible();
  await page.keyboard.press("Meta+n");
  await page.keyboard.type("Kept Note");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Kept Note" })).toBeVisible();
}

test("a deleted workspace comes back from the Undo strip, where it was and with its note", async ({ page }) => {
  await workspaceWithNote(page);
  await wsRow(page, "Workspace 2").click();
  await page.keyboard.press("Backspace");
  await expect(wsRow(page, "Workspace 2")).toHaveCount(0);
  await expect(page.getByText("Deleted “Workspace 2”")).toBeVisible();
  await expect(trashedRow(page, "Workspace 2")).toHaveCount(0); // the section starts collapsed
  await expect(trashSection(page)).toContainText("Trash");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(wsRow(page, "Workspace 2")).toHaveClass(/(^|\s)bg-accent(\s|$)/);
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Kept Note" })).toBeVisible();
  await expect(trashSection(page)).toHaveCount(0); // the trash is empty again
});

test("the strip's Trash section restores a deleted workspace with `r`", async ({ page }) => {
  await workspaceWithNote(page);
  await wsRow(page, "Workspace 2").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete Workspace" }).click();
  await expect(wsRow(page, "Workspace 2")).toHaveCount(0);
  await trashSection(page).getByRole("button", { name: /Trash/ }).click();
  await trashedRow(page, "Workspace 2").click();
  await page.keyboard.press("r");
  await expect(wsRow(page, "Workspace 2")).toBeVisible();
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Kept Note" })).toBeVisible();
});

test("Delete Permanently asks first, focused on Cancel, and says how many notes go", async ({ page }) => {
  await workspaceWithNote(page);
  await wsRow(page, "Workspace 2").click();
  await page.keyboard.press("Backspace");
  await trashSection(page).getByRole("button", { name: /Trash/ }).click();
  await trashedRow(page, "Workspace 2").click();
  await page.keyboard.press("d");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete “Workspace 2” permanently?");
  await expect(dialog).toContainText("Its 1 note");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Delete Permanently" }).click();
  await expect(trashSection(page)).toHaveCount(0);
  const left = await page.evaluate(() => window.__harness.deletedWorkspaces());
  expect(left).toEqual([]);
});

test("an attached workspace's ⌫ is Remove from Ledge, and Undo adds the folder back", async ({ page }) => {
  await page.getByLabel("Add workspace options").click();
  await page.getByRole("menuitem", { name: /Attach Folder as Workspace/ }).click();
  // The dialog asks for a path; the harness's Choose Folder… fills its one
  // external folder (workspaces-scoped.spec.ts does the same).
  const dialog = page.getByRole("dialog", { name: /Attach Folder/ });
  await dialog.getByRole("button", { name: "Choose Folder…" }).click();
  await dialog.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(wsRow(page, "external")).toBeVisible();
  await wsRow(page, "external").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove from Ledge" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete Workspace" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Remove from Ledge" }).click();
  await expect(wsRow(page, "external")).toHaveCount(0);
  await expect(page.getByText("Removed “external” from Ledge")).toBeVisible();
  await expect(trashSection(page)).toHaveCount(0); // nothing went to the trash
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(wsRow(page, "external")).toBeVisible();
});
