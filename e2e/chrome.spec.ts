// App-level chrome: the three overlay modes (⌘P notes, ⇧⌘P commands, ⌥⌘P
// full-text search, `>`/`#` to cross between them), ⌘⌫ as the chord form of
// delete, Empty Trash's confirmation, and the modal-suppression rule (§6:
// while a layer is open, the window dispatcher is silent).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// What the editor's selection says, read off the Range: WebKit's
// Selection.toString() can be empty for a selection CodeMirror set
// programmatically, while the Range itself always knows its text.
const selectedText = (page: Page) =>
  page.evaluate(() => {
    const s = window.getSelection();
    return s && s.rangeCount ? s.getRangeAt(0).toString() : "";
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("⌘P quick-open filters notes and Enter opens the pick", async ({ page }) => {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("gam");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content").first()).toContainText("gamma body");
});

test("⇧⌘P opens the command palette and Enter runs the pick", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+P");
  await page.keyboard.type("toggle sidebar");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Workspaces")).toBeHidden();
});

test("`>` as the first character crosses from notes to commands", async ({ page }) => {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type(">toggle sidebar");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Workspaces")).toBeHidden();
});

test("`#` searches note bodies; Enter opens the hit with the match selected", async ({ page }) => {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("#beta body");
  // Wait for the hit row (results arrive debounced): [data-active] is the
  // overlay's highlighted row, and nothing outside the overlay carries it.
  await expect(page.locator("[data-active]")).toContainText("beta body");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content").first()).toContainText("beta body");
  // The reveal put the selection on the match itself, not just opened the note.
  await expect.poll(() => selectedText(page)).toBe("beta body");
});

test("⌥⌘P is the direct route to search mode, and Backspace over `#` returns to titles", async ({ page }) => {
  await page.keyboard.press("Alt+Meta+p");
  await expect(page.getByPlaceholder("Search inside notes")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("#");
  await expect(page.getByPlaceholder("Search inside notes")).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(page.getByPlaceholder(/> commands/)).toBeVisible();
});

test("a search hit on an already-open note focuses its tab and reveals the line", async ({ page }) => {
  // Open Beta first, then search for its body text: openNote must reuse the
  // tab (no second tab on one path) and the reveal must still land, even
  // though no fresh editor attach happens.
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("beta");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content").first()).toContainText("beta body");
  const tabs = await page.locator("[data-tab]").count();
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("#beta body");
  // Not getByText: Beta's editor already shows "beta body", and Enter must not
  // fire before the debounced hits actually land in the overlay.
  await expect(page.locator("[data-active]")).toContainText("beta body");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-tab]")).toHaveCount(tabs);
  await expect.poll(() => selectedText(page)).toBe("beta body");
});

test("⌘⌫ on a focused note row deletes that note, with Undo", async ({ page }) => {
  await noteRow(page, "Alpha").click();
  await page.keyboard.press("Meta+Backspace");
  await expect(noteRow(page, "Alpha")).toHaveCount(0);
  await expect(page.getByText("Deleted “Alpha”")).toBeVisible();
});

test("Empty Trash confirms, focused on Cancel, and empties on confirm", async ({ page }) => {
  await page.getByRole("button", { name: /^Trash/ }).click();
  await page.getByRole("button", { name: "Empty" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Empty the trash?");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Empty Trash" }).click();
  await expect(page.getByRole("button", { name: /^Trash/ })).toHaveCount(0);
});

test("the settings snapshot reaches its consumers: the seeded editor font size applies", async ({ page }) => {
  // The harness seeds editor.fontSize 18 (the default is 14), so 18px here
  // proves the boot → configureSettings → createEditor chain, not a hardcode.
  await noteRow(page, "Alpha").click();
  const size = await page
    .locator(".cm-editor")
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(size).toBe("18px");
});

test("⌘, asks Bun to open the settings file", async ({ page }) => {
  await page.keyboard.press("Meta+,");
  expect(await page.evaluate(() => window.__harness.settingsOpens())).toBe(1);
});

test("an open context menu suppresses the dispatcher; Escape closes only the menu", async ({ page }) => {
  await noteRow(page, "Beta").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Delete/ })).toBeVisible();
  // A bare `d` with the menu open must not fire the row verb underneath.
  await page.keyboard.press("d");
  await expect(noteRow(page, "Beta")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(noteRow(page, "Beta")).toBeVisible(); // Escape addressed the menu, nothing else
});
