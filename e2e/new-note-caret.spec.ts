// Where the caret lands in a note that was just created: on the H1, after
// the "# ", so the first keystroke names the note instead of pushing text in
// front of the hash that makes the line a heading (the H1 is the rename UI —
// a keystroke landing before it would unmake the title). A title the app made
// up ("Untitled") is SELECTED, so one keystroke replaces it; ⌘J's date title
// is one the app computed and only gets the caret, because a stray keystroke
// must not rename the day. Typing is the proof: a spec reading the selection
// out of CodeMirror would pass on a caret nobody can type at.
import { expect, test, type Page } from "@playwright/test";

const SCRATCH = "/harness/scratch";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const tab = (page: Page, title: string) => page.locator("[data-tab]", { hasText: title });
// The caret's own line, which is the only one showing its raw "# " (live
// preview conceals the marker everywhere else).
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
  // Named in one keystroke run: the tab (and the file behind it) follow the H1.
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
