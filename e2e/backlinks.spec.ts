// The Backlinks panel (workspace/BacklinksPanel.tsx). ⌥⌘L toggles the
// right-hand panel. It lists each note that links here, with the link's line
// and the text of that line. A row opens the linking note at the link, the
// way the search overlay opens a hit. Runs in real WebKit because unit tests
// cannot see row focus or the reveal (testing.md §5).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const backlinkRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="backlink"]', { hasText: title });
const panel = (page: Page) => page.locator("aside", { hasText: "Backlinks" });

// Creates a note linking to Alpha, typed into the editor rather than seeded
// into the harness store. The [[ picker pops mid-typing and closes at the
// first ], so it leaves the typed text alone. The wikilinks specs rely on the
// same behavior.
async function createLinker(page: Page): Promise<void> {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Linker\n\nsee [[Alpha]] here");
  await expect(noteRow(page, "Linker")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("⌥⌘L toggles the panel; a note with no incoming links shows the empty state", async ({ page }) => {
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Alt+Meta+l");
  await expect(panel(page)).toBeVisible();
  // Alpha's one incoming [[Alpha]] sits in the locked Codebook fixture, and
  // the scan skips locked notes (harness.tsx mirrors bun/notes.ts), so no row
  // appears. The same fetch returns lockedSkipped=1, so this aside also
  // carries the "1 locked note not scanned" footer. Unsealing or editing that
  // fixture breaks this test.
  await expect(panel(page)).toContainText("No notes link here");

  // The same key closes the panel again.
  await page.keyboard.press("Alt+Meta+l");
  await expect(panel(page)).toHaveCount(0);
});

test("the header button toggles too, and an unsaved note explains itself", async ({ page }) => {
  // ⌘N's scratch tab has no file yet, so nothing can link to it. The panel
  // says so instead of the "No notes link here" hint it shows for a saved
  // note with no backlinks.
  await page.keyboard.press("Meta+n");
  await page.getByTitle("Toggle Backlinks (⌥⌘L)").click();
  await expect(panel(page)).toContainText("no file yet");
});

test("an incoming [[link]] lists the linking note with its line and context", async ({ page }) => {
  await createLinker(page);
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Alt+Meta+l");

  const row = backlinkRow(page, "Linker");
  await expect(row).toBeVisible();
  // The context is the linking line as written, the raw [[Alpha]] rather than
  // the concealed rendering. The row also carries the link's line number,
  // 1-based.
  await expect(row).toContainText("see [[Alpha]] here");
  await expect(row).toContainText("3");
});

test("clicking a row opens the linking note with the link's line revealed", async ({ page }) => {
  await createLinker(page);
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Alt+Meta+l");
  await backlinkRow(page, "Linker").click();

  // Linker's tab is up and the selection landed on the link's line. A
  // wikilink shows its raw text only while the selection touches it, so the
  // spec looks for "[[Alpha]]" on screen rather than the concealed "Alpha"
  // (the wikilinks specs check it the same way). The reveal also focuses the
  // editor. A plain note-row open leaves focus on the row (PaneTree.tsx).
  await expect(page.locator("[data-tab]", { hasText: "Linker" })).toBeVisible();
  await expect(page.locator(".cm-line", { hasText: "see [[Alpha]] here" })).toBeVisible();
  const focusInEditor = await page.evaluate(() => !!document.activeElement?.closest(".cm-editor"));
  expect(focusInEditor).toBe(true);
});

test("Enter on a focused row opens at the link, like every list's row verb", async ({ page }) => {
  await createLinker(page);
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Alt+Meta+l");

  await backlinkRow(page, "Linker").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-tab]", { hasText: "Linker" })).toBeVisible();
  await expect(page.locator(".cm-line", { hasText: "see [[Alpha]] here" })).toBeVisible();
});

test("the panel follows the shown note, and links inside fences do not count", async ({ page }) => {
  await createLinker(page);
  // A second note whose [[Alpha]] sits in a fenced block. wikiRefsOf skips
  // fenced lines (shared/wikilinks.ts), so no row should appear for Logs.
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Logs\n\n```\n[[Alpha]]\n```");
  await expect(noteRow(page, "Logs")).toBeVisible();

  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Alt+Meta+l");
  await expect(backlinkRow(page, "Linker")).toBeVisible();
  await expect(backlinkRow(page, "Logs")).toHaveCount(0);

  // Switching notes swaps the list: Beta has no incoming links.
  await noteRow(page, "Beta").click();
  await expect(panel(page)).toContainText("No notes link here");
  await expect(backlinkRow(page, "Linker")).toHaveCount(0);
});
