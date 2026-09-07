// Where the caret lands in a just-created note: on the H1, after the "# "
// (workspace/reveal.ts revealTitle). A note titled "Untitled" opens with the
// title selected, so one keystroke replaces it. A new daily note opens with
// its date unselected, so a keystroke adds to the date. The specs type and
// check the text: typing can land elsewhere while the selection looks right.
import { expect, test, type Page } from "@playwright/test";

const SCRATCH = "/harness/scratch";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const tab = (page: Page, title: string) => page.locator("[data-tab]", { hasText: title });
// The editor's first line, which holds the H1 in every fixture here. The raw
// "# " is in its text because live preview shows the marker on the heading
// the selection touches, and conceals it on every other heading.
const titleLine = (page: Page) => page.locator(".cm-editor .cm-line").first();

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("⌘N opens on the title with the placeholder selected", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  await expect(tab(page, "Untitled")).toBeVisible();
  await page.keyboard.type("Ship It");
  await expect(titleLine(page)).toHaveText("# Ship It");
  // The tab label follows the H1, and so does the file's name. Typing a title
  // names the note.
  await expect(tab(page, "Ship It")).toBeVisible();
});

test("⌘J's new daily note gets the caret but keeps its date", async ({ page }) => {
  await page.keyboard.press("Meta+j");
  await expect(tab(page, today())).toBeVisible();
  await page.keyboard.type("Standup ");
  await expect(titleLine(page)).toHaveText(`# Standup ${today()}`);
});

test("a note instantiated from a template opens the same way", async ({ page }) => {
  await page.evaluate((r) => {
    window.__harness.store.seed(r, "---\ntemplate: true\n---\n# Meeting\n\nAgenda.\n");
    window.__harness.notesChanged(r);
  }, SCRATCH);
  await expect(noteRow(page, "Meeting")).toBeVisible();
  await page.keyboard.press("Alt+Meta+n");
  await expect(page.locator("[data-active]")).toContainText("New Note from Template: Meeting");
  await page.keyboard.press("Enter");
  await expect(tab(page, "Untitled")).toBeVisible();
  await page.keyboard.type("Retro");
  await expect(titleLine(page)).toHaveText("# Retro");
});
