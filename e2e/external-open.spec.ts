// The view's share of `ledge <title>`: an openExternal push (driven through
// window.__harness.externalOpen — the Bun watcher behind the real one has no
// browser surface) selects the workspace that shows the note's root and opens
// the note's tab. The Bun half — resolving the title, guarding the path,
// consuming the request file — is openRequest.fs.test.ts's subject.
import { expect, test, type Page } from "@playwright/test";

const SCRATCH = "/harness/scratch";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const tab = (page: Page, title: string) => page.locator("[data-tab]", { hasText: title });

async function externalOpen(page: Page, root: string, title: string): Promise<void> {
  await page.evaluate(
    ([r, t]) => {
      const note = window.__harness.store.list(r!).find((n) => n.title === t);
      if (!note) throw new Error(`no seeded note titled ${t}`);
      window.__harness.externalOpen({ root: r!, path: note.path, title: note.title, mtimeMs: note.mtimeMs });
    },
    [root, title],
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("an external open lands as a tab in the note's own workspace", async ({ page }) => {
  await externalOpen(page, SCRATCH, "Beta");
  await expect(tab(page, "Beta")).toBeVisible();
});

test("from another workspace, the note's workspace is selected first — then the tab", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N"); // workspace 2, now selected, empty
  await expect(noteRow(page, "Alpha")).toHaveCount(0);
  await externalOpen(page, SCRATCH, "Beta");
  // Back in workspace 1: its browser lists Alpha again, and Beta's tab is up.
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(tab(page, "Beta")).toBeVisible();
});

test("a second open of the same note focuses the live tab instead of growing a twin", async ({ page }) => {
  await externalOpen(page, SCRATCH, "Beta");
  await expect(tab(page, "Beta")).toBeVisible();
  await externalOpen(page, SCRATCH, "Beta");
  await expect(tab(page, "Beta")).toHaveCount(1);
});
