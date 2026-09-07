// External-edit safety, from the UI side. The specs rewrite a note through
// window.__harness.store.writeExternal, then refresh with a synthetic window
// focus event, which runs the same reload as the watcher push (App.tsx).
// notes/store.test.ts covers the store's decisions and bun/notes.fs.test.ts
// covers the disk guard.
import { expect, test, type Page } from "@playwright/test";

const ALPHA = "/harness/scratch/alpha.md";
const SCRATCH = "/harness/scratch";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

const agentWrites = (page: Page, path: string, text: string) =>
  page.evaluate(([p, t]) => window.__harness.store.writeExternal(p, t), [path, text] as const);

const refresh = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await noteRow(page, "Alpha").click();
  await expect(page.locator(".cm-content")).toContainText("alpha body");
});

test("a clean open note follows its file: the next refresh pours in the agent's text", async ({ page }) => {
  await agentWrites(page, ALPHA, "# Alpha\n\nan agent rewrote this from the drawer\n");
  await refresh(page);
  await expect(page.locator(".cm-content")).toContainText("an agent rewrote this from the drawer");
});

test("a disk-side H1 edit relabels the tab — and only relabels: no rename, no reload loop", async ({ page }) => {
  await agentWrites(page, ALPHA, "# Alpha Prime\n\nalpha body\n");
  await refresh(page);
  await expect(page.locator("[data-tab]", { hasText: "Alpha Prime" })).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("Alpha Prime");
});

test("an agent appending to a note that ends with a running block lands BELOW the output panel", async ({ page }) => {
  // A note ends with a fence whose run panel is showing, and something
  // outside the app appends below the fence. The appended text has to land
  // below the panel, not between the fence and its output. Two things do that:
  // the reload dispatches the smallest changed span, not a full replace, and
  // the run anchor maps with assoc -1, so text inserted at it stays below.
  const FENCED = "# Alpha\n\n```sh\necho hi\n```\n";
  await agentWrites(page, ALPHA, FENCED);
  await refresh(page);
  await expect(page.locator(".cm-content")).toContainText("echo hi");
  // Run it: the harness PTY is inert, so the run stays live with its panel
  // mounted under the fence.
  await page.locator('[data-act="run"]').dispatchEvent("mousedown", { button: 0 });
  await expect(page.locator(".ledge-output")).toBeVisible();

  await agentWrites(page, ALPHA, FENCED + "\n> a joke from the agent\n");
  await refresh(page);
  const appended = page.locator(".cm-line", { hasText: "a joke from the agent" });
  await expect(appended).toBeVisible();
  const [panel, text] = await Promise.all([
    page.locator(".ledge-output").boundingBox(),
    appended.boundingBox(),
  ]);
  expect(panel!.y).toBeLessThan(text!.y);
});

test("a dirty editor holds its ground; the displaced disk version lands in the trash, not oblivion", async ({ page }) => {
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus my half-typed thought");
  // The agent's write lands while the edit is still inside the autosave
  // debounce: the refresh must not clobber the buffer.
  await agentWrites(page, ALPHA, "# Alpha\n\nthe agent's competing version\n");
  await refresh(page);
  await expect(page.locator(".cm-content")).toContainText("plus my half-typed thought");
  await expect(page.locator(".cm-content")).not.toContainText("competing version");
  // The autosave then flushes carrying the baseMtimeMs it recorded before the
  // agent wrote. The fake store (mirroring bun/notes.ts) sees the mismatch and
  // moves the agent's version to the trash. The seeded trash note plus this
  // one make two, so nothing was destroyed.
  await expect
    .poll(() => page.evaluate((root) => window.__harness.store.listTrash(root).length, SCRATCH))
    .toBe(2);
});

test("the displaced version is announced, not just logged: the browser's notice strip names the note", async ({
  page,
}) => {
  // The same setup as the test above, checked from the UI side. The trash
  // assertion there proves nothing was destroyed; this one proves the user is
  // told, which the console.warn beside the notice (store.ts) does not do on
  // its own.
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus my half-typed thought");
  await agentWrites(page, ALPHA, "# Alpha\n\nthe version from the other device\n");

  await expect(page.getByText(/“Alpha” also changed elsewhere/)).toBeVisible();
  await expect(page.getByText(/the other one is in the Trash/)).toBeVisible();
});
