// The Outline panel (workspace/OutlinePanel.tsx). ⌥⌘O toggles it in the
// right-hand slot, which shows one face at a time: Backlinks, Outline, or
// Tags (App.tsx `rightFace`). Rows are the active note's headings from the
// live editor doc, and a row jumps the caret there. Run in real WebKit: the
// live rows, row focus, and the jump need a live editor (testing.md §5).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const headingRow = (page: Page, text: string) =>
  page.locator('[data-target-kind="heading"]', { hasText: text });
const panel = (page: Page) => page.locator("aside", { hasText: "Outline" });
const backlinks = (page: Page) => page.locator("aside", { hasText: "Backlinks" });

// Types a note with headings at three levels, keystroke by keystroke rather
// than setting the doc, so the rows arrive the way they do for a person
// typing. The `# comment` inside the fence is the fake heading a pasted log
// leaves behind: headingsOf skips fenced lines (shared/wikilinks.ts), so no
// row should appear for it.
async function createDoc(page: Page): Promise<void> {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Doc\n\nintro\n\n## Section One\n\nbody\n\n### Sub\n\n```\n# comment\n```");
  await expect(noteRow(page, "Doc")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("⌥⌘O toggles the panel; the active note's headings are its rows", async ({ page }) => {
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Alt+Meta+o");
  await expect(panel(page)).toBeVisible();
  await expect(headingRow(page, "Alpha")).toBeVisible();

  // The same key closes the panel again.
  await page.keyboard.press("Alt+Meta+o");
  await expect(panel(page)).toHaveCount(0);
});

test("headings appear live as they are typed; fenced fakes do not", async ({ page }) => {
  // Opens the panel before typing anything, so the rows this test asserts
  // arrive through the docEvents broadcast (editor/setup.ts fires it from a
  // CodeMirror update listener) rather than from the one scan the panel runs
  // when it mounts.
  await noteRow(page, "Alpha").click();
  await page.getByTitle("Toggle Outline (⌥⌘O)").click();
  await createDoc(page);

  await expect(headingRow(page, "Doc")).toBeVisible();
  await expect(headingRow(page, "Section One")).toBeVisible();
  await expect(headingRow(page, "Sub")).toBeVisible();
  await expect(headingRow(page, "comment")).toHaveCount(0);
});

test("clicking a row puts the caret on the heading, in the editor", async ({ page }) => {
  await createDoc(page);
  await page.keyboard.press("Alt+Meta+o");
  await headingRow(page, "Section One").click();

  // There is no way to read the caret, so the reveal proves it: a heading's
  // ## marks show raw only while the selection touches the heading
  // (editor/livePreview.ts). The wikilinks spec checks the same way. The jump
  // focuses the editor too (commands/glue.ts jumpToHeading goes through
  // withView).
  await expect(page.locator(".cm-line", { hasText: "## Section One" })).toBeVisible();
  const focusInEditor = await page.evaluate(() => !!document.activeElement?.closest(".cm-editor"));
  expect(focusInEditor).toBe(true);
});

test("Enter on a focused row jumps too, like every list's row verb", async ({ page }) => {
  await createDoc(page);
  await page.keyboard.press("Alt+Meta+o");
  await headingRow(page, "Sub").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line", { hasText: "### Sub" })).toBeVisible();
});

test("one right slot: outline and backlinks swap rather than stack", async ({ page }) => {
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Alt+Meta+l");
  await expect(backlinks(page)).toBeVisible();

  // Opening the other face replaces this one rather than stacking, and the
  // face's own key closes it.
  await page.keyboard.press("Alt+Meta+o");
  await expect(panel(page)).toBeVisible();
  await expect(backlinks(page)).toHaveCount(0);
  await page.keyboard.press("Alt+Meta+o");
  await expect(panel(page)).toHaveCount(0);
  await expect(backlinks(page)).toHaveCount(0);
});

test("the panel follows the shown note", async ({ page }) => {
  await createDoc(page);
  await page.keyboard.press("Alt+Meta+o");
  await expect(headingRow(page, "Section One")).toBeVisible();

  await noteRow(page, "Beta").click();
  await expect(headingRow(page, "Beta")).toBeVisible();
  await expect(headingRow(page, "Section One")).toHaveCount(0);
});
