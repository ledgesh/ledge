// Which workspaces exist, and what they are called, is the server's registry,
// so every client connected to one server shows the same strip (remote.md §5).
// The harness's store stands in for the server. A spec edits it the way another
// client's call would have, then sends the workspacesChanged push that call
// sends, or lets a focus refresh find the change the way a lost push is found.
import { expect, test, type Page } from "@playwright/test";

const wsRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="workspace"]', { hasText: name });

const SCRATCH = "/harness/scratch";
const EXTERNAL = "/harness/external";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(wsRow(page, "Scratch")).toBeVisible();
});

test("a workspace another client added appears, named by its label, without taking the selection", async ({ page }) => {
  await page.evaluate((root) => {
    window.__harness.store.attach(root);
    window.__harness.store.labels.set(root, { name: "Anypost", symbol: "star" });
    window.__harness.workspacesChanged();
  }, EXTERNAL);
  await expect(wsRow(page, "Anypost")).toBeVisible();
  await expect(wsRow(page, "Scratch")).toHaveClass(/(^|\s)bg-accent(\s|$)/);
  // It arrived with its notes: switching to it shows the folder's seeded note.
  await wsRow(page, "Anypost").click();
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Delta" })).toBeVisible();
});

test("a push lost while away is made up by the next focus refresh", async ({ page }) => {
  await page.evaluate((root) => window.__harness.store.attach(root), EXTERNAL);
  await expect(wsRow(page, "external")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  // No label on the server: the folder's name, the name attaching gives.
  await expect(wsRow(page, "external")).toBeVisible();
});

test("renaming a workspace stores the name on the server for the other clients", async ({ page }) => {
  await wsRow(page, "Scratch").click();
  await page.keyboard.press("r");
  const field = page.locator('[data-target-kind="workspace"]').getByRole("textbox");
  await field.fill("Research");
  await page.keyboard.press("Enter");
  await expect(wsRow(page, "Research")).toBeVisible();
  await expect
    .poll(() => page.evaluate((root) => window.__harness.store.labels.get(root)?.name ?? null, SCRATCH))
    .toBe("Research");
});

test("another client's rename renames the row here", async ({ page }) => {
  await page.evaluate((root) => {
    window.__harness.store.labels.set(root, { name: "Inbox" });
    window.__harness.workspacesChanged();
  }, SCRATCH);
  await expect(wsRow(page, "Inbox")).toBeVisible();
  await expect(wsRow(page, "Scratch")).toHaveCount(0);
});

test("a workspace another client removed leaves the strip", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+N");
  await expect(wsRow(page, "Workspace 2")).toBeVisible();
  // The create stored the name on the server, the label a phone would read.
  const root = await page.evaluate(
    () => [...window.__harness.store.labels].find(([, l]) => l.name === "Workspace 2")?.[0] ?? null,
  );
  expect(root).not.toBeNull();
  await page.evaluate((r) => {
    window.__harness.store.detach(r!);
    window.__harness.workspacesChanged();
  }, root);
  await expect(wsRow(page, "Workspace 2")).toHaveCount(0);
  // Its neighbour takes the selection it had.
  await expect(wsRow(page, "Scratch")).toHaveClass(/(^|\s)bg-accent(\s|$)/);
});
