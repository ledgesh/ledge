// The Favorites section in headless WebKit: the marker's whole round trip
// through the view, which unit tests cannot see. The marker is a frontmatter
// line Bun writes (bun/notes.ts favoriteNote), so these specs check the two
// ends of that: the section and the star follow the note list, and the line
// itself reaches an open editor the way any external edit does.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// A row of the Favorites section, told apart from the same note's row in the
// tree by its list id (notes/folders.ts favoriteRowId).
const favoriteRow = (page: Page, slug: string) => page.locator(`[data-list-row^="fav:"][data-list-row$="${slug}"]`);

const treeRow = (page: Page, slug: string) => page.locator(`[data-list-row$="${slug}"]:not([data-list-row^="fav:"])`);

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("`f` on a focused row favorites it, and the section appears above the tree", async ({ page }) => {
  await expect(page.getByText("Favorites")).toHaveCount(0); // nothing marked, no heading
  await treeRow(page, "beta.md").click();
  await page.keyboard.press("f");
  await expect(page.getByText("Favorites")).toBeVisible();
  await expect(favoriteRow(page, "beta.md")).toBeVisible();
  // The note keeps its place in the tree as well: the section says which
  // notes, the tree still says where they are.
  await expect(treeRow(page, "beta.md")).toBeVisible();
});

test("the marker is a frontmatter line, and it reaches the open editor", async ({ page }) => {
  await treeRow(page, "beta.md").click();
  await expect(page.locator(".cm-content").first()).toContainText("beta body");
  await page.keyboard.press("f");
  // Written by Bun, poured back into the buffer by the external-edit reload
  // (workspace/editorPool.ts reloadOpenNotes), not by anything the view typed.
  await expect(page.locator(".cm-line", { hasText: "favorite: true" })).toBeVisible();
  await page.keyboard.press("f");
  await expect(page.locator(".cm-line", { hasText: "favorite: true" })).toHaveCount(0);
});

test("`f` on the section's own row unfavorites the note", async ({ page }) => {
  await treeRow(page, "gamma.md").click();
  await page.keyboard.press("f");
  await favoriteRow(page, "gamma.md").click();
  await page.keyboard.press("f");
  await expect(favoriteRow(page, "gamma.md")).toHaveCount(0);
  await expect(page.getByText("Favorites")).toHaveCount(0); // the last one leaves no heading
  await expect(treeRow(page, "gamma.md")).toBeVisible();
});

test("the row menu carries the verb, titled for the row it is about", async ({ page }) => {
  await treeRow(page, "beta.md").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Favorite" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Favorite" }).click();
  await expect(favoriteRow(page, "beta.md")).toBeVisible();
  // The same row's menu now offers the other face, which is how the menu says
  // which way the verb goes.
  await treeRow(page, "beta.md").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Unfavorite" })).toBeVisible();
});

test("the star appears without moving the row it appears in", async ({ page }) => {
  // The button is taller than the title beside it, so the row holds that
  // height at rest (NoteBrowser ROW_CLASS). Without it every row the pointer
  // crossed grew a little as it went.
  const row = treeRow(page, "gamma.md");
  const rest = await row.boundingBox();
  await row.hover();
  await expect(row.getByRole("button", { name: "Favorite" })).toBeVisible();
  expect((await row.boundingBox())?.height).toBe(rest?.height);
});

test("the hover star toggles the marker without opening the note", async ({ page }) => {
  // Gamma is not open, and clicking its star must not open it: the star is a
  // control inside the row, and the row's own click is stopped there.
  await treeRow(page, "alpha.md").click();
  await treeRow(page, "gamma.md").hover();
  await treeRow(page, "gamma.md").getByRole("button", { name: "Favorite" }).click();
  await expect(favoriteRow(page, "gamma.md")).toBeVisible();
  await expect(page.locator(".cm-content").first()).toContainText("alpha body");
});
