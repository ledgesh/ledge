// Notes are local to a workspace: the browser, quick-open (⌘P), full-text
// search (⌥⌘P), and the Trash section show only the selected workspace's
// folder. These specs cover those four surfaces. They also cover attaching a
// folder, where the harness fakes the native dialog and returns
// /harness/external, and closing a workspace then attaching the same folder
// again, which proves the close deleted nothing.
import { expect, test, type Page } from "@playwright/test";

const wsRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="workspace"]', { hasText: name });
const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// Run a command by title through the palette (⇧⌘P, type, Enter). Used here
// for Attach Folder as Workspace…, which has no chord of its own
// (commands/keys.ts).
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
  // The new workspace opens on a seeded scratch tab. Typing in it triggers
  // the first save. That save creates the file in the new workspace's folder.
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("hello from workspace two");
  // Once the autosave debounce fires the note is on disk and shows up in the
  // browser, titled "Untitled" after the scratch seed's H1.
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
  // The seeded Alpha/Beta/Gamma belong to workspace 1, so none of them should
  // show up here. The match is exact because the sidebar's own empty state
  // ("No notes yet. A new note…") is a longer text node that would also match
  // without it.
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
  // A delete in workspace 1 lands in workspace 1's trash. Workspace 2 stays
  // clean.
  await page.keyboard.press("Meta+1");
  await noteRow(page, "Beta").click();
  await page.keyboard.press("d");
  await expect(noteRow(page, "Beta")).toHaveCount(0);
  await page.keyboard.press("Meta+2");
  await expect(page.getByText("Trash", { exact: true })).toHaveCount(0);
});

test("attach surfaces the picked folder's notes as a new workspace", async ({ page }) => {
  await runFromPalette(page, "Attach Folder");
  // The new workspace is named after the folder ("external"), and it becomes
  // the selected workspace. The notes already in that folder are listed.
  await expect(wsRow(page, "external")).toHaveClass(/bg-accent/);
  await expect(noteRow(page, "Delta")).toBeVisible();
  await expect(noteRow(page, "Epsilon")).toBeVisible();
  // Full-text search now runs against the attached folder. Only Delta's
  // seeded body carries this needle (harness.tsx).
  await page.keyboard.press("Alt+Meta+p");
  await page.getByPlaceholder("Search inside notes").fill("external needle");
  await expect(page.locator("[data-active]")).toContainText("Delta");
});

test("close then re-attach: the folder's notes survived the close", async ({ page }) => {
  await runFromPalette(page, "Attach Folder");
  await expect(noteRow(page, "Delta")).toBeVisible();
  // Close the workspace (⌫ on its focused row). Closing removes only the
  // registry entry. The files must not be deleted.
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
  // The menu lists both workspace-adding commands from the registry.
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /New Workspace/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Attach Folder as Workspace/ }).click();
  // This is the same flow the palette route takes. The fake dialog picks
  // /harness/external.
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
