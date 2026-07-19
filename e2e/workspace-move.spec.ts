// Move Workspace Folder…: the workspace row's menu (and the palette) relocate
// the folder on disk. A managed workspace goes straight to the harness's fake
// destination picker (always /synced — the cloud-folder stand-in); an
// external one stops at the in-app chooser first, whose "Move to ~/.ledge"
// option is the pickerless return trip. The contract these specs hold: the
// workspace keeps its identity in the strip, every note travels to the new
// root, open tabs close (arrangement loss, not data loss — interactions.md
// §4), and work continues against the new handles: a reopened note edits and
// saves under the moved root.
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
  // A note open in a tab, so the close-on-move is observable.
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Enter");
  await expect(tab(page, "Alpha")).toBeVisible();

  await wsRow(page, "Scratch").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: /Move Workspace Folder/ }).click();

  // The workspace kept its name and selection; the note tab is gone — its
  // path named the old folder — and the pane holds a fresh scratch tab.
  await expect(wsRow(page, "Scratch")).toHaveClass(/bg-accent/);
  await expect(tab(page, "Alpha")).toHaveCount(0);
  await expect(tab(page, "Untitled")).toBeVisible();

  // Every note travelled: the browser lists them from the new root, and a
  // reopened one carries its text.
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

  // Work continues against the moved folder's handles: reopen, type, and the
  // save lands without complaint (the harness throws on any path outside its
  // roots, so a stale old-root path here would fail the spec loudly).
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Enter");
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" moved");
  await expect(page.locator(".cm-content").first()).toContainText("moved");
});

test("an external workspace's Move stops at the chooser: Escape cancels, ~/.ledge is the return trip", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Move Workspace Folder" });

  // Managed: straight to the (fake) picker — the move lands with no chooser
  // ever appearing.
  await runFromPalette(page, "Move Workspace Folder…");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // External now: the same command opens the chooser instead, and Escape
  // walks away without moving anything.
  await runFromPalette(page, "Move Workspace Folder…");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The return trip: the row menu's Move, then the ~/.ledge option. Every
  // note lands back, the workspace still itself.
  await wsRow(page, "Scratch").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: /Move Workspace Folder/ }).click();
  await dialog.getByRole("button", { name: "Move to ~/.ledge" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(wsRow(page, "Scratch")).toHaveCount(1);
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Enter");
  await expect(tab(page, "Alpha")).toBeVisible();

  // Managed again: the command goes straight to the picker once more.
  await runFromPalette(page, "Move Workspace Folder…");
  await expect(dialog).toHaveCount(0);
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("moving to where the folder already lives is a no-op: nothing closes", async ({ page }) => {
  // The fake picker always answers /synced, so a second move through the
  // chooser's picker option targets the folder's own parent. Bun's contract
  // for that is "same root back, nothing renamed" — and the view's side of
  // the bargain is that open tabs survive, since nothing moved out from
  // under them.
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
  // Given a beat to (not) act: the tab is still here, the strip unchanged.
  await expect(tab(page, "Alpha")).toBeVisible();
  await expect(wsRow(page, "Scratch")).toHaveCount(1);
});
