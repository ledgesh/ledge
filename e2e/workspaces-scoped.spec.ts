// Notes are local to a workspace: the browser, quick-open (⌘P), full-text
// search (⌥⌘P), and the Trash section all show the SELECTED workspace's
// folder and nothing else's. These specs hold every scoped surface to that,
// plus the two folder-lifecycle flows the harness fakes end to end: attach
// (the "native dialog" returns /harness/external) and close → re-attach
// (proving a close deletes nothing).
import { expect, test, type Page } from "@playwright/test";

const wsRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="workspace"]', { hasText: name });
const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// Run a palette-only command by title (⇧⌘P → type → Enter).
async function runFromPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");
  await page.getByPlaceholder("Run a command").fill(title);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("a new workspace starts with an empty browser; the first keeps its notes", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N");
  await expect(wsRow(page, "Workspace 2")).toHaveClass(/bg-accent/);
  await expect(noteRow(page, "Alpha")).toHaveCount(0);
  await expect(page.getByText("No notes yet")).toBeVisible();
  await page.keyboard.press("Meta+1");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("a note typed in workspace 2 lists there and only there", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N");
  // The new workspace's seeded scratch tab: typing in it triggers the first
  // save, which creates the file in THIS workspace's folder.
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("hello from workspace two");
  // Past the autosave debounce: the created note joins the browser ("Untitled"
  // — the scratch seed's H1).
  await expect(noteRow(page, "Untitled")).toBeVisible();
  await page.keyboard.press("Meta+1");
  await expect(noteRow(page, "Untitled")).toHaveCount(0);
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("⌘P quick-open lists only the selected workspace's notes", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N");
  await page.keyboard.press("Meta+p");
  const input = page.getByPlaceholder(/Search notes/);
  await expect(input).toBeVisible();
  // The seeded Alpha/Beta/Gamma belong to workspace 1: none may appear here.
  // exact: the sidebar's own empty state ("No notes yet. A new note…") is a
  // different, longer text node and must not satisfy this.
  await expect(page.getByText("No notes yet", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+1");
  await page.keyboard.press("Meta+p");
  await input.fill("alp");
  await expect(page.locator("[data-active]")).toContainText("Alpha");
});

test("⌥⌘P full-text search is scoped to the selected workspace", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N");
  await page.keyboard.press("Alt+Meta+p");
  const input = page.getByPlaceholder("Search inside notes");
  await input.fill("alpha body");
  await expect(page.getByText("No matches")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+1");
  await page.keyboard.press("Alt+Meta+p");
  await input.fill("alpha body");
  await expect(page.locator("[data-active]")).toContainText("Alpha");
});

test("the Trash section is the selected workspace's; deletes stay in their folder", async ({ page }) => {
  // Workspace 1 boots with one seeded trashed note ("Older").
  await expect(page.getByText("Trash", { exact: true })).toBeVisible();
  await page.keyboard.press("Meta+Shift+N");
  // Workspace 2's folder has an empty trash, so the section hides entirely.
  await expect(page.getByText("Trash", { exact: true })).toHaveCount(0);
  // A delete in workspace 1 lands in ITS trash; workspace 2 stays clean.
  await page.keyboard.press("Meta+1");
  await noteRow(page, "Beta").click();
  await page.keyboard.press("d");
  await expect(noteRow(page, "Beta")).toHaveCount(0);
  await page.keyboard.press("Meta+2");
  await expect(page.getByText("Trash", { exact: true })).toHaveCount(0);
});

test("attach surfaces the picked folder's notes as a new workspace", async ({ page }) => {
  await runFromPalette(page, "Attach Folder");
  // The workspace is named after the folder ("external") and selected; its
  // pre-existing notes are simply there.
  await expect(wsRow(page, "external")).toHaveClass(/bg-accent/);
  await expect(noteRow(page, "Delta")).toBeVisible();
  await expect(noteRow(page, "Epsilon")).toBeVisible();
  // And scoped search sees them, and only them.
  await page.keyboard.press("Alt+Meta+p");
  await page.getByPlaceholder("Search inside notes").fill("external needle");
  await expect(page.locator("[data-active]")).toContainText("Delta");
});

test("close then re-attach: the folder's notes survived the close", async ({ page }) => {
  await runFromPalette(page, "Attach Folder");
  await expect(noteRow(page, "Delta")).toBeVisible();
  // Close the workspace (⌫ on its focused row). Files must NOT be deleted:
  // only the registry entry goes.
  await wsRow(page, "external").click();
  await page.keyboard.press("Backspace");
  await expect(wsRow(page, "external")).toHaveCount(0);
  // Re-attach: everything is still in the folder.
  await runFromPalette(page, "Attach Folder");
  await expect(wsRow(page, "external")).toBeVisible();
  await expect(noteRow(page, "Delta")).toBeVisible();
  await expect(noteRow(page, "Epsilon")).toBeVisible();
});

test("the + button's dropdown offers both ways to add a workspace", async ({ page }) => {
  await page.getByLabel("Add workspace options").click();
  // Both commands, straight from the registry: New Workspace shows its chord
  // chip, Attach has none.
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /New Workspace/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Attach Folder as Workspace/ }).click();
  // Same flow as the palette route: the fake dialog picks /harness/external.
  await expect(wsRow(page, "external")).toHaveClass(/bg-accent/);
  await expect(noteRow(page, "Delta")).toBeVisible();
});

test("attaching an already-attached folder selects it instead of duplicating", async ({ page }) => {
  await runFromPalette(page, "Attach Folder");
  await expect(wsRow(page, "external")).toBeVisible();
  await page.keyboard.press("Meta+1"); // back to Scratch
  await runFromPalette(page, "Attach Folder");
  await expect(wsRow(page, "external")).toHaveCount(1);
  await expect(wsRow(page, "external")).toHaveClass(/bg-accent/);
});
