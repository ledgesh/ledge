// External-edit safety, the user-observable half: a note rewritten behind the
// app's back (window.__harness.store.writeExternal — the "agent in the
// terminal" seam) follows into a CLEAN open editor on the next refresh, while
// a DIRTY editor holds its ground and the displaced disk version surfaces in
// the Trash. The store-side decisions live in notes/store.test.ts and the
// disk-side guard in bun/notes.fs.test.ts; these specs pin the seam between
// them to what a user actually sees. The refresh is driven by a synthetic
// window focus event — the same listener the watcher push shares (App.tsx).
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
  // The tier-2/3 shape: a prompt block is the last thing in the note, its run
  // appends to the note, and the appended text must not wedge itself between
  // the fence and its output. Two things carry this: the reload dispatches a
  // minimal span (an insertion at the end, not a full replace), and the run
  // anchor maps with assoc -1 so an insertion exactly at it stays below.
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
  // debounce: the refresh must NOT clobber the buffer.
  await agentWrites(page, ALPHA, "# Alpha\n\nthe agent's competing version\n");
  await refresh(page);
  await expect(page.locator(".cm-content")).toContainText("plus my half-typed thought");
  await expect(page.locator(".cm-content")).not.toContainText("competing version");
  // The autosave then flushes with its stale expectation; the fake store
  // (mirroring bun/notes.ts) diverts the agent's version to the trash. One
  // seeded trash note plus this one — nothing was destroyed.
  await expect
    .poll(() => page.evaluate((root) => window.__harness.store.listTrash(root).length, SCRATCH))
    .toBe(2);
});
