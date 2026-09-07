// Move Workspace Folder…, from the workspace row's menu and from the palette.
// It relocates the folder on disk. A managed workspace goes straight to the
// harness's fake destination picker, which always answers /synced (the
// cloud-folder stand-in). An external one stops at the in-app chooser first,
// whose "Move to ~/.ledge" option needs no picker. The tabs the move closes
// lose an arrangement and not data (interactions.md §4).
import { expect, test, type Page } from "@playwright/test";

const wsRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="workspace"]', { hasText: name });
const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const tab = (page: Page, label: string) => page.locator("[data-tab]", { hasText: label });

async function runFromPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");
  await page.getByPlaceholder("Run a command").fill(title);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("the row menu's Move relocates the folder: notes travel, tabs close, the workspace stays itself", async ({ page }) => {
  // The spec opens a note in a tab first, so the tab closing after the move is
  // visible.
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Enter");
  await expect(tab(page, "Alpha")).toBeVisible();

  await wsRow(page, "Scratch").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: /Move Workspace Folder/ }).click();

  // The workspace row is still there under its name. /bg-accent/ is a loose
  // check: an unselected row carries hover:bg-accent/50, which matches it too
  // (workspace-rows.spec.ts anchors the pattern). The note tab is gone and the
  // pane holds a fresh scratch tab. workspaceFolderMoved swaps the whole pane
  // tree, so every tab in the workspace closes (workspace/store.tsx).
  await expect(wsRow(page, "Scratch")).toHaveClass(/bg-accent/);
  await expect(tab(page, "Alpha")).toHaveCount(0);
  await expect(tab(page, "Untitled")).toBeVisible();

  // Alpha travelled: the browser lists it from the new root, and reopening it
  // shows its text. Beta and Gamma move with the folder too, but this spec does
  // not look for them.
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Enter");
  await expect(tab(page, "Alpha")).toBeVisible();
  await expect(page.locator(".cm-content").first()).toContainText("Alpha");
});

test("the palette route moves the selected workspace, and editing continues on the new root", async ({ page }) => {
  await runFromPalette(page, "Move Workspace Folder…");
  await expect(tab(page, "Untitled")).toBeVisible();
  await expect(noteRow(page, "Alpha")).toBeVisible();

  // The note reopens and takes an edit. The assertion reads the editor buffer,
  // not the store: the save waits out SAVE_DELAY_MS (notes/store.ts) and the
  // test ends as soon as the text appears. A write under a stale old-root path
  // would be rejected by the harness and logged rather than failed, so nothing
  // here proves the save landed on the new root.
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Enter");
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" moved");
  await expect(page.locator(".cm-content").first()).toContainText("moved");
});

test("an external workspace's Move stops at the chooser: Escape cancels, ~/.ledge is the return trip", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Move Workspace Folder" });

  // The workspace is managed here, so the command goes straight to the fake
  // picker and no chooser appears. Neither assertion below shows the move
  // landing: Alpha is visible either way, and the dialog never exists on the
  // managed path. The chooser in the next block is what proves this move ran,
  // since only an external workspace gets one.
  await runFromPalette(page, "Move Workspace Folder…");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // The workspace is external after that move, so the same command opens the
  // chooser instead. Escape cancels it without moving anything.
  await runFromPalette(page, "Move Workspace Folder…");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The folder moves back under ~/.ledge, through the row menu's Move and the
  // chooser's ~/.ledge option. Alpha is listed again and the strip still holds
  // one Scratch row.
  await wsRow(page, "Scratch").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: /Move Workspace Folder/ }).click();
  await dialog.getByRole("button", { name: "Move to ~/.ledge" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(wsRow(page, "Scratch")).toHaveCount(1);
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Enter");
  await expect(tab(page, "Alpha")).toBeVisible();

  // The workspace is managed again, so the command goes straight to the picker
  // once more.
  await runFromPalette(page, "Move Workspace Folder…");
  await expect(dialog).toHaveCount(0);
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("moving to where the folder already lives is a no-op: nothing closes", async ({ page }) => {
  // The fake picker always answers /synced, so a second move through the
  // chooser's picker option targets the folder's own parent. The harness's
  // move() answers the same root back and rekeys nothing, mirroring moveRoot's
  // own-parent no-op (bun/workspaces.ts). The view leaves open tabs alone when
  // the root comes back unchanged (workspace/actions.ts).
  await runFromPalette(page, "Move Workspace Folder…");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Enter");
  await expect(tab(page, "Alpha")).toBeVisible();
  await runFromPalette(page, "Move Workspace Folder…");
  await page
    .getByRole("dialog", { name: "Move Workspace Folder" })
    .getByRole("button", { name: "Choose Another Location…" })
    .click();
  // Nothing closed: the tab is still open and the strip is unchanged. Both
  // assertions pass as soon as they run and nothing sleeps first, so they catch
  // only a close that has already happened. There is nothing here to wait on.
  // The check is a weak one, and a wait added to strengthen it would be a
  // guess at how long.
  await expect(tab(page, "Alpha")).toBeVisible();
  await expect(wsRow(page, "Scratch")).toHaveCount(1);
});
