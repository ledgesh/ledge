// The workspace strip is the third row list, and R6 says every list gets the
// same grammar: Enter = primary (switch to it), ⌫ = destructive (close), `r`
// mnemonic (rename). These specs hold the strip to that — and to the guards
// around it: the last workspace cannot close, and an inline rename field is
// typing, not a row, so keys pressed in it must never fire verbs.
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
  await page.keyboard.press("Meta+Shift+N"); // second workspace, selected on creation
  await expect(wsRow(page, "Workspace 2")).toHaveClass(/bg-accent/);
  // Arrow up to Scratch: focus moves without selecting (focus is a cursor,
  // Enter is the verb)…
  await wsRow(page, "Workspace 2").click();
  await page.keyboard.press("ArrowUp");
  expect(await focusedRowKey(page)).not.toBeNull();
  // (^|\s) rather than a bare token: the unselected row still carries the
  // hover:bg-accent/50 utility, which a loose /bg-accent/ would match.
  await expect(wsRow(page, "Scratch")).not.toHaveClass(/(^|\s)bg-accent(\s|$)/);
  // …and Enter commits the switch.
  await page.keyboard.press("Enter");
  await expect(wsRow(page, "Scratch")).toHaveClass(/(^|\s)bg-accent(\s|$)/);
});

test("`r` begins an inline rename; committing it renames the workspace", async ({ page }) => {
  await wsRow(page, "Scratch").click();
  await page.keyboard.press("r");
  // Located through the row kind, not the row's text: once the field opens,
  // the name is the input's VALUE, so a hasText:"Scratch" row matches nothing.
  const field = page.locator('[data-target-kind="workspace"]').getByRole("textbox");
  await expect(field).toBeVisible();
  await field.fill("Research");
  await page.keyboard.press("Enter");
  await expect(wsRow(page, "Research")).toBeVisible();
  await expect(wsRow(page, "Scratch")).toHaveCount(0);
});

test("keys typed in the rename field are typing, never row verbs", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N"); // a second workspace, so close is even possible
  await wsRow(page, "Workspace 2").click();
  await page.keyboard.press("r");
  const field = page.locator('[data-target-kind="workspace"]').getByRole("textbox");
  await expect(field).toBeVisible();
  // ⌫ inside the field edits text; `r` types an r. If either fired as a row
  // verb this would close the workspace or nest a rename. (→ first: the field
  // select-alls on mount, and ArrowRight collapses that to the end, where ⌫
  // deletes one character instead of the whole selection.)
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
  await expect(wsRow(page, "Scratch")).toHaveClass(/bg-accent/); // fell back to the survivor
});

test("the last workspace refuses to close", async ({ page }) => {
  await wsRow(page, "Scratch").click();
  await page.keyboard.press("Backspace");
  await expect(wsRow(page, "Scratch")).toBeVisible();
});
