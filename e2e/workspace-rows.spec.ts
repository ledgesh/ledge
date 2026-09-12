// The workspace strip is a row list, and interactions.md R6 gives every row
// kind the same grammar: Enter is the primary action (switch to it), ⌫ the
// destructive one (close it), `r` the rename mnemonic. These specs cover that
// grammar and its two guards: the last workspace cannot close, and while the
// rename field is open the keys go into the text, not to the row verbs.
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

test("⌫ closes the focused workspace", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N");
  await wsRow(page, "Workspace 2").click();
  await page.keyboard.press("Backspace");
  await expect(wsRow(page, "Workspace 2")).toHaveCount(0);
  // Scratch is the workspace left behind. The regex is the loose one, so this
  // shows the row is still there rather than that it is now selected.
  await expect(wsRow(page, "Scratch")).toHaveClass(/bg-accent/);
});

test("the last workspace refuses to close", async ({ page }) => {
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
