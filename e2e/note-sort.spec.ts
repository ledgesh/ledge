// The note browser's sort, in headless WebKit: the header button and the two
// command faces, the hold while the pointer is over the list, and the layout
// file carrying the choice. notes/folders.test.ts covers the order itself.
//
// The fixture seeds Alpha, Beta, Gamma and then Codebook, each a minute after
// the last, so last modified reads Codebook, Gamma, Beta, Alpha.
import { expect, test, type Page } from "@playwright/test";

const SCRATCH = "/harness/scratch";
const ALPHA = `${SCRATCH}/alpha.md`;

const noteRow = (page: Page, title: string) => page.locator('[data-target-kind="note"]', { hasText: title });

const noteTitles = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-target-kind="note"]')).map((el) => el.textContent?.trim()),
  );

// A write from outside the view, then the watcher's push that lists it.
const agentWrites = (page: Page, path: string, text: string) =>
  page.evaluate(
    ([p, t, root]) => {
      window.__harness.store.writeExternal(p, t);
      window.__harness.notesChanged(root);
    },
    [path, text, SCRATCH] as const,
  );

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("the header button switches to last modified and back", async ({ page }) => {
  await expect.poll(() => noteTitles(page)).toEqual(["Alpha", "Beta", "Codebook", "Gamma"]);
  await page.getByRole("button", { name: "Sort Notes by Last Modified" }).click();
  await expect.poll(() => noteTitles(page)).toEqual(["Codebook", "Gamma", "Beta", "Alpha"]);
  // The button now offers the other face.
  await page.getByRole("button", { name: "Sort Notes by Title" }).click();
  await expect.poll(() => noteTitles(page)).toEqual(["Alpha", "Beta", "Codebook", "Gamma"]);
});

test("the palette offers only the face that changes the order", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("Sort Notes");
  const overlay = page.getByTestId("overlay-list");
  await expect(overlay.getByText("Sort Notes by Last Modified")).toBeVisible();
  await expect(overlay.getByText("Sort Notes by Title")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => noteTitles(page)).toEqual(["Codebook", "Gamma", "Beta", "Alpha"]);
});

test("a save moves its note to the top, but not while the pointer is over the list", async ({ page }) => {
  await page.getByRole("button", { name: "Sort Notes by Last Modified" }).click();
  await noteRow(page, "Beta").hover();
  await agentWrites(page, ALPHA, "# Alpha\n\nrewritten\n");
  // The list holds the order it showed when the pointer arrived, so the row
  // under the pointer is still Beta.
  await page.waitForTimeout(200);
  expect(await noteTitles(page)).toEqual(["Codebook", "Gamma", "Beta", "Alpha"]);
  await page.mouse.move(900, 400); // into the editor
  await expect.poll(() => noteTitles(page)).toEqual(["Alpha", "Codebook", "Gamma", "Beta"]);
});

test("the choice is saved with the layout", async ({ page }) => {
  await page.getByRole("button", { name: "Sort Notes by Last Modified" }).click();
  await expect.poll(() => page.evaluate(() => window.__harness.layout() ?? "")).toContain('"sort":"modified"');
  await page.getByRole("button", { name: "Sort Notes by Title" }).click();
  await expect.poll(() => page.evaluate(() => window.__harness.layout() ?? "")).not.toContain('"sort"');
});
