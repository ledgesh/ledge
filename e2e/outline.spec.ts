// The Outline panel (workspace/OutlinePanel.tsx): ⌥⌘O toggles the right-hand
// panel's other face, the active note's headings derive LIVE from the editor
// doc, and a row jumps the caret to its heading. Run in real WebKit because
// the live derivation (the docEvents broadcast riding CodeMirror's update
// listener), row focus, and the caret jump are exactly what unit tests cannot
// see (testing.md §5).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const headingRow = (page: Page, text: string) =>
  page.locator('[data-target-kind="heading"]', { hasText: text });
const panel = (page: Page) => page.locator("aside", { hasText: "Outline" });
const backlinks = (page: Page) => page.locator("aside", { hasText: "Backlinks" });

// A note with structure, typed like a person would. The fenced `# comment` is
// the classic fake heading: pasted logs, not structure.
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

  // Toggle is a toggle, from the same key.
  await page.keyboard.press("Alt+Meta+o");
  await expect(panel(page)).toHaveCount(0);
});

test("headings appear live as they are typed; fenced fakes do not", async ({ page }) => {
  // Panel first, THEN the typing: every row below arrived through the
  // docEvents broadcast, not a mount-time snapshot.
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

  // The caret proof is the reveal itself: a heading's ## marks show raw only
  // while the caret touches its line (the wikilinks specs' concealment
  // trick). A jump is "take me there": focus belongs in the editor.
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

  // Opening the other face replaces, never stacks — and its own key closes.
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
