// The Archived section in headless WebKit: the archive marker's round trip
// through the view. The marker is a frontmatter line Bun writes (bun/notes.ts
// archiveNote), so these check what the view does with the flag: the row
// leaves the tree for the section, the Undo strip offers it back, the pickers
// rank it last, and the open note says it is archived (interactions.md §3).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

const treeRow = (page: Page, slug: string) =>
  page.getByTestId("note-list").locator(`[data-list-row$="${slug}"]:not([data-list-row^="fav:"])`);

const archivedRow = (page: Page, slug: string) => page.getByTestId("archived-list").locator(`[data-list-row$="${slug}"]`);

const archivedHeading = (page: Page) => page.getByTestId("archived-heading");

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("`a` archives the focused row: it leaves the tree for a closed section", async ({ page }) => {
  await expect(archivedHeading(page)).toHaveCount(0); // nothing archived, no section
  await treeRow(page, "beta.md").click();
  await page.keyboard.press("a");
  await expect(treeRow(page, "beta.md")).toHaveCount(0);
  await expect(archivedHeading(page)).toContainText("1");
  await expect(page.getByTestId("archived-list")).toHaveCount(0); // closed until opened
  await archivedHeading(page).click();
  await expect(archivedRow(page, "beta.md")).toBeVisible();
  // `a` on the section's own row brings it back, and the empty section goes.
  await archivedRow(page, "beta.md").click();
  await page.keyboard.press("a");
  await expect(treeRow(page, "beta.md")).toBeVisible();
  await expect(archivedHeading(page)).toHaveCount(0);
});

test("the Undo strip puts an archived note back", async ({ page }) => {
  await treeRow(page, "gamma.md").click();
  await page.keyboard.press("a");
  await expect(page.getByText("Archived “Gamma”.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(treeRow(page, "gamma.md")).toBeVisible();
  await expect(archivedHeading(page)).toHaveCount(0);
});

test("the row menu carries the verb, and Favorite greys on an archived note", async ({ page }) => {
  await treeRow(page, "beta.md").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Archive" }).click();
  await archivedHeading(page).click();
  await archivedRow(page, "beta.md").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Unarchive" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Favorite" })).toBeDisabled();
});

test("an open archived note says so at its frontmatter, and the button unarchives it", async ({ page }) => {
  await treeRow(page, "beta.md").click();
  await expect(page.locator(".cm-content").first()).toContainText("beta body");
  await page.keyboard.press("a");
  // Bun writes the line and the external-edit reload pours it into the buffer.
  await expect(page.locator(".cm-line", { hasText: "archived: true" })).toBeVisible();
  const hint = page.getByTestId("fm-archived");
  await expect(hint).toHaveText("Archived: Unarchive");
  // Its own row under the block, not a chip on the closing `---`.
  expect(
    await hint.evaluate((el) => el.closest(".ledge-fm-hints")?.previousElementSibling?.classList.contains("ledge-fm-fence")),
  ).toBe(true);
  await hint.click();
  await expect(page.locator(".cm-line", { hasText: "archived: true" })).toHaveCount(0);
  await expect(treeRow(page, "beta.md")).toBeVisible();
});

test("quick-open lists an archived note last, wearing the archive glyph", async ({ page }) => {
  await treeRow(page, "alpha.md").click();
  await page.keyboard.press("a");
  await expect(archivedHeading(page)).toBeVisible();
  await page.keyboard.press("Meta+p");
  const rows = page.getByTestId("overlay-list").locator("> div");
  await expect(rows.last()).toContainText("Alpha");
  await expect(rows.last().getByTestId("overlay-archived-glyph")).toBeVisible();
  await expect(rows.last().getByTestId("overlay-archived-tag")).toHaveText("Archived");
  await expect(rows.first().getByTestId("overlay-archived-glyph")).toHaveCount(0);
  await expect(rows.first().getByTestId("overlay-archived-tag")).toHaveCount(0);
});

test("a text-search hit in an archived note says Archived beside its title", async ({ page }) => {
  await treeRow(page, "beta.md").click();
  await page.keyboard.press("a");
  await expect(archivedHeading(page)).toBeVisible();
  await page.keyboard.press("Meta+Alt+p");
  await page.keyboard.type("beta body");
  const hit = page.getByTestId("overlay-list").locator("> div", { hasText: "Beta" });
  await expect(hit.getByTestId("overlay-archived-tag")).toHaveText("Archived");
});

test("text search lists an archived note's hits after every other note's", async ({ page }) => {
  // Beta is newer than Alpha, so without the archive rule its hit would lead.
  await treeRow(page, "beta.md").click();
  await page.keyboard.press("a");
  await expect(archivedHeading(page)).toBeVisible();
  await page.keyboard.press("Meta+Alt+p");
  await page.keyboard.type("body");
  const rows = page.getByTestId("overlay-list").locator("> div");
  await expect(rows.last()).toContainText("beta body");
  await expect(rows.first().getByTestId("overlay-archived-tag")).toHaveCount(0);
});
