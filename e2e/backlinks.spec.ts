// The Backlinks panel (workspace/BacklinksPanel.tsx): ⌥⌘L toggles the
// right-hand panel, an incoming [[link]] lists its note with line and
// context, and opening a row lands in the linking note AT the link — the
// search overlay's open-at-the-hit as a row verb. Run in real WebKit because
// panel focus, row focus, and the reveal are exactly what unit tests cannot
// see (docs/testing.md §5).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const backlinkRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="backlink"]', { hasText: title });
const panel = (page: Page) => page.locator("aside", { hasText: "Backlinks" });

// A note linking to Alpha, created through the editor like a person would.
// The [[ picker pops mid-typing and closes itself at the first ] — same
// non-interference the wikilinks specs rely on.
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
  await expect(panel(page)).toContainText("No notes link here");

  // Toggle is a toggle, from the same key.
  await page.keyboard.press("Alt+Meta+l");
  await expect(panel(page)).toHaveCount(0);
});

test("the header button toggles too, and an unsaved note explains itself", async ({ page }) => {
  // ⌘N's scratch tab has no file yet — nothing can link to it, and the panel
  // says why instead of showing a bare zero.
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
  // The context is the linking LINE as written — the raw [[Alpha]], not the
  // concealed rendering — plus its 1-based line number.
  await expect(row).toContainText("see [[Alpha]] here");
  await expect(row).toContainText("3");
});

test("clicking a row opens the linking note with the link's line revealed", async ({ page }) => {
  await createLinker(page);
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Alt+Meta+l");
  await backlinkRow(page, "Linker").click();

  // Linker's tab is up, and the caret landed on the link's line — proven by
  // the reveal: a wikilink shows raw only while the caret touches it, so
  // seeing "[[Alpha]]" (not the concealed "Alpha") IS the caret (the
  // wikilinks specs' trick). A reveal is "take me there": focus belongs in
  // the editor, unlike a plain note-row open.
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
  // A second note whose [[Alpha]] sits in a fence: pasted logs, not a link.
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
