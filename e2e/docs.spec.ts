// The built-in documentation: a hidden read-only workspace (kind "docs").
// The header's book button (and the palette's Documentation entry) opens it;
// it never gets a strip row; its pages open, search, and RUN like ordinary
// notes, but nothing edits, creates, or deletes — the affordances hide, the
// editor drops keystrokes, and the harness store (like the real one) refuses
// any write that slips past.
import { expect, test, type Page } from "@playwright/test";

const wsRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="workspace"]', { hasText: name });
const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const docsButton = (page: Page) => page.getByTitle("Documentation", { exact: true });

async function openDocs(page: Page): Promise<void> {
  await docsButton(page).click();
  await expect(noteRow(page, "Getting Started")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("the book button opens the docs on Getting Started, with no strip row", async ({ page }) => {
  await openDocs(page);
  // Landed on the page, not a scratch tab: the tab bar names it.
  await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toBeVisible();
  await expect(page.locator(".cm-line").first()).toHaveText("# Getting Started");
  // Hidden workspace: the strip still shows only Scratch, nothing highlights,
  // and the browser wears the read-only badge.
  await expect(wsRow(page, "Documentation")).toHaveCount(0);
  await expect(page.getByText("read-only")).toBeVisible();
  // Both docs pages list; the user's notes do not.
  await expect(noteRow(page, "Workspaces Guide")).toBeVisible();
  await expect(noteRow(page, "Alpha")).toHaveCount(0);
});

test("⌘1 is the way back, and the docs workspace survives reopening", async ({ page }) => {
  await openDocs(page);
  await page.keyboard.press("Meta+1");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  // Reopening selects the existing docs workspace rather than growing a twin:
  // the same tab is still there.
  await openDocs(page);
  await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toHaveCount(1);
});

test("the editor is read-only: keystrokes land nowhere, and no save ever fires", async ({ page }) => {
  await openDocs(page);
  const first = page.locator(".cm-line").first();
  await first.click();
  await page.keyboard.type("VANDALIZED");
  await expect(first).toHaveText("# Getting Started");
  // The fake store's page is untouched (no autosave snuck through).
  const text = await page.evaluate(() =>
    window.__harness.store.readNote("/harness/.ledge-docs/getting-started.md"),
  );
  expect(text).toContain("# Getting Started");
  expect(text).not.toContain("VANDALIZED");
});

test("runnable blocks still run — the docs demos are live", async ({ page }) => {
  await openDocs(page);
  await page.locator(".cm-line", { hasText: "echo hello from the docs" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
});

test("no create or delete affordances: buttons hidden, row menu trimmed, verbs refused", async ({ page }) => {
  await openDocs(page);
  // The browser's New Note footer and the tab strip's + are gone.
  await expect(page.getByRole("button", { name: "New Note" })).toHaveCount(0);
  await expect(page.getByTitle(/New Note/)).toHaveCount(0);
  // The row menu carries Open and Copy Path — no Delete, no lock faces.
  await noteRow(page, "Getting Started").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Delete/ })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: /Lock/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // The bare `d` row verb is gated too: the row (and the page) survive.
  await noteRow(page, "Getting Started").click();
  await page.keyboard.press("d");
  await expect(noteRow(page, "Getting Started")).toBeVisible();
});

test("⌘P and ⌥⌘P are scoped to the docs while it is selected", async ({ page }) => {
  await openDocs(page);
  await page.keyboard.press("Meta+p");
  const quick = page.getByPlaceholder(/Search notes/);
  await quick.fill("getting");
  await expect(page.locator("[data-active]")).toContainText("Getting Started");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+Meta+p");
  await page.getByPlaceholder("Search inside notes").fill("docs needle");
  await expect(page.locator("[data-active]")).toContainText("Getting Started");
});

test("the palette's Documentation entry is the other doorway", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+P");
  await page.getByPlaceholder("Run a command").fill("Documentation");
  await page.keyboard.press("Enter");
  await expect(noteRow(page, "Getting Started")).toBeVisible();
  await expect(wsRow(page, "Documentation")).toHaveCount(0);
});
