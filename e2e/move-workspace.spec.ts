// Moving a note to another workspace, driven in headless WebKit: the row
// verb Move to Workspace… and its chooser, a drag of the row onto a workspace
// row in the strip, what travels with the note (its open tab), and the Undo
// strip that brings it back. The harness fakes the move as a rekey between
// two roots (harness.tsx FakeStore.moveNoteToWorkspace); the asset copy and
// the lock refusal are Bun's and are tested there (bun/notes.fs.test.ts).
import { expect, test, type Page } from "@playwright/test";

const wsRow = (page: Page, name: string) => page.locator('[data-target-kind="workspace"]', { hasText: name });
const noteRow = (page: Page, title: string) => page.locator('[data-target-kind="note"]', { hasText: title });
const tab = (page: Page, title: string) => page.locator("[data-tab]", { hasText: title });

// A second workspace to move into, with the first selected again afterwards.
async function withSecondWorkspace(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Shift+N");
  await expect(wsRow(page, "Workspace 2")).toBeVisible();
  await page.keyboard.press("Meta+1");
  await expect(noteRow(page, "Alpha")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("with one workspace there is nowhere to go, so the verb is disabled", async ({ page }) => {
  await noteRow(page, "Alpha").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Move to Workspace…" })).toBeDisabled();
});

test("Move to Workspace… moves the note and its open tab, and Undo brings both back", async ({ page }) => {
  await withSecondWorkspace(page);
  await noteRow(page, "Alpha").click();
  await expect(tab(page, "Alpha")).toBeVisible();
  await noteRow(page, "Alpha").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Workspace…" }).click();
  await page.getByTestId("workspace-picker-row").filter({ hasText: "Workspace 2" }).click();
  // Gone from this workspace's list and pane, named on the strip.
  await expect(noteRow(page, "Alpha")).toHaveCount(0);
  await expect(tab(page, "Alpha")).toHaveCount(0);
  await expect(page.getByText(/Moved “Alpha” to “Workspace 2”/)).toBeVisible();
  // Present in the other's list and pane: the tab travelled with the note
  // (workspace/store.tsx noteMovedWorkspace).
  await page.keyboard.press("Meta+2");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(tab(page, "Alpha")).toBeVisible();
  // Undo is the same move back, offered on the strip of the workspace the
  // note left, so it is taken from there.
  await page.keyboard.press("Meta+1");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(tab(page, "Alpha")).toBeVisible();
  await page.keyboard.press("Meta+2");
  await expect(noteRow(page, "Alpha")).toHaveCount(0);
});

test("dropping a note on a workspace row is the same move", async ({ page }) => {
  // A pointer gesture rather than a second command (interactions.md R4): the
  // drop and the chooser both land in NoteBrowser.tsx's moveAcross.
  await withSecondWorkspace(page);
  await noteRow(page, "Beta").dragTo(wsRow(page, "Workspace 2"));
  await expect(noteRow(page, "Beta")).toHaveCount(0);
  await expect(page.getByText(/Moved “Beta” to “Workspace 2”/)).toBeVisible();
  await page.keyboard.press("Meta+2");
  await expect(noteRow(page, "Beta")).toBeVisible();
});
