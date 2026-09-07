// The Tags panel (workspace/TagsPanel.tsx) and the overlay's #-query, which
// routes into the same drill-in. Opening an occurrence runs tag.openNote,
// which is backlink.open's body with a tag target: it lands in the bearing
// note at the tag. Runs in real WebKit because unit tests cannot see row
// focus, the reveal, or where focus lands afterwards (testing.md §5).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const tagRow = (page: Page, tag: string) =>
  page.locator('[data-target-kind="tag"]', { hasText: tag });
const hitRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="tagnote"]', { hasText: title });
const panel = (page: Page) => page.locator("aside", { hasText: "Tags" });
const drilled = (page: Page, tag: string) => page.locator("aside", { hasText: `#${tag}` });

// Creates a note carrying #ledge twice, typed through the editor the way a
// person would rather than seeded into the harness store, so the tag scan
// reads what the editor path wrote. Two occurrences in one note, so the
// directory counts it once.
async function createTagged(page: Page): Promise<void> {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Tagged\n\nwork on #ledge today\nand #ledge again");
  await expect(noteRow(page, "Tagged")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("⌥⌘T toggles the panel; a tagless workspace shows the empty state", async ({ page }) => {
  await page.keyboard.press("Alt+Meta+t");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText("No tags yet");

  // The same key closes it.
  await page.keyboard.press("Alt+Meta+t");
  await expect(panel(page)).toHaveCount(0);
});

test("typed and frontmatter tags merge; counts are notes, not occurrences", async ({ page }) => {
  await createTagged(page);
  // A second bearer, declaring the tag in frontmatter rather than in the body.
  await page.keyboard.press("Meta+n");
  // A new note opens with the caret in its seeded "# Untitled" heading. ⌘↑
  // moves it to the very start of the document, ahead of the "# ", because a
  // frontmatter block counts only when it opens the file.
  await page.keyboard.press("Meta+ArrowUp");
  for (const line of ["---", "tags: ledge", "---", "# Front", "", "body"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await expect(noteRow(page, "Front")).toBeVisible();

  await page.getByTitle("Toggle Tags (⌥⌘T)").click();
  const row = tagRow(page, "ledge");
  await expect(row).toBeVisible();
  // Three occurrences across two notes: the directory counts the notes.
  await expect(row).toContainText("2");
});

test("a directory row drills into occurrences; opening one reveals the line", async ({ page }) => {
  await createTagged(page);
  await noteRow(page, "Alpha").click(); // leave the tagged note before jumping back into it
  await page.keyboard.press("Alt+Meta+t");
  await tagRow(page, "ledge").click();

  // The panel is showing #ledge, with one row per occurrence. A row carries
  // the trimmed text of the line and the line's 1-based number.
  await expect(drilled(page, "ledge")).toBeVisible();
  await expect(hitRow(page, "Tagged")).toHaveCount(2);
  await expect(hitRow(page, "Tagged").first()).toContainText("work on #ledge today");
  await expect(hitRow(page, "Tagged").first()).toContainText("3");

  await hitRow(page, "Tagged").first().click();
  // The bearing note has a tab in the strip, its editor is showing the tag's
  // line, and focus is in the editor.
  await expect(page.locator("[data-tab]", { hasText: "Tagged" })).toBeVisible();
  await expect(page.locator(".cm-line", { hasText: "work on #ledge today" })).toBeVisible();
  const focusInEditor = await page.evaluate(() => !!document.activeElement?.closest(".cm-editor"));
  expect(focusInEditor).toBe(true);
});

test("Enter on a focused occurrence row opens too, like every list's row verb", async ({ page }) => {
  await createTagged(page);
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Alt+Meta+t");
  await tagRow(page, "ledge").click();

  await hitRow(page, "Tagged").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-tab]", { hasText: "Tagged" })).toBeVisible();
  await expect(page.locator(".cm-line", { hasText: "work on #ledge today" })).toBeVisible();
});

test("the drill-in backs out to the directory", async ({ page }) => {
  await createTagged(page);
  await page.keyboard.press("Alt+Meta+t");
  await tagRow(page, "ledge").click();
  await expect(hitRow(page, "Tagged").first()).toBeVisible();

  await page.getByTitle("All tags").click();
  await expect(tagRow(page, "ledge")).toBeVisible();
});

test("one right slot: tags and outline swap rather than stack", async ({ page }) => {
  await page.keyboard.press("Alt+Meta+t");
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Alt+Meta+o");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("aside", { hasText: "Outline" })).toBeVisible();
  await page.keyboard.press("Alt+Meta+t");
  await expect(panel(page)).toBeVisible();
  await expect(page.locator("aside", { hasText: "Outline" })).toHaveCount(0);
});

test("a #query in the overlay surfaces tag rows; Enter lands in the drill-in", async ({ page }) => {
  await createTagged(page);
  await page.keyboard.press("Meta+p");
  const input = page.getByPlaceholder("Search notes");
  await input.fill("#led");

  // The tag row renders above the text hits and starts active. The hits below
  // are the ordinary full-text ones, since a #tag is text too.
  await expect(page.locator("[data-active]")).toContainText("#ledge");
  await expect(page.locator("[data-active]")).toContainText("1 note");

  await page.keyboard.press("Enter");
  await expect(drilled(page, "ledge")).toBeVisible();
  await expect(hitRow(page, "Tagged")).toHaveCount(2);
});
