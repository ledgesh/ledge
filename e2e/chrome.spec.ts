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
  await expect(page.getByPlaceholder("Search notes")).toBeVisible();
});

// --- the three modes as three controls --------------------------------------
//
// The sigils were the only way across that did not need a chord, and both of
// them are on the third plane of an iPhone keyboard (123, then #+=). The chips
// are the crossing a client with no keys can make, and they are here as well as
// there for a reason a Mac cares about too: the mode used to be invisible state
// (Overlay.tsx derived it and showed nothing), and the query used to be lost at
// every crossing.
const chip = (page: Page, name: string) =>
  page.locator("div.fixed.inset-0.z-50").getByRole("button", { name: new RegExp(`^${name}`) });

test("a chip crosses modes and carries the query with it", async ({ page }) => {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("gam");
  await chip(page, "Text").click();
  const field = page.getByPlaceholder("Search inside notes");
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("gam");
  // And back, with the field still holding it — and still focused, so the next
  // keystroke lands where the caret looks like it is.
  await chip(page, "Notes").click();
  await expect(page.getByPlaceholder("Search notes")).toHaveValue("gam");
  await expect(page.getByPlaceholder("Search notes")).toBeFocused();
});

test("the chip names its sigil, on a client where the sigil is one keystroke", async ({ page }) => {
  await page.keyboard.press("Meta+p");
  await expect(chip(page, "Commands")).toContainText(">");
  await expect(chip(page, "Text")).toContainText("#");
});

test("a title search that matches nothing offers the text search, and Enter takes it", async ({
  page,
}) => {
  await page.keyboard.press("Meta+p");
  // A phrase no note is TITLED and one note contains: the empty state used to
  // say "No notes match", which is true and is not where the answer was.
  await page.keyboard.type("beta body");
  await expect(page.locator("[data-crossing]")).toContainText("Search “beta body” in note text");
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Search inside notes")).toHaveValue("beta body");
  await expect(page.locator("[data-active]")).toContainText("beta body");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content").first()).toContainText("beta body");
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

test("⌘, opens the settings editor on the commented file; Escape closes without saving", async ({ page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  // A fresh install opens on the seeded template — the comments ARE the
  // documentation, so their presence is the point.
  await expect(dialog.locator(".cm-content")).toContainText("Ledge settings");
  const before = await page.evaluate(() => window.__harness.settingsText("server"));
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__harness.settingsText("server"))).toBe(before);
});

test("a settings edit warns live on a bad value and saves byte-for-byte", async ({ page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type('{ "trash": { "ttlDays": 0 } }');
  // The problems strip previews exactly what launch-time validation would say.
  await expect(dialog.getByText(/must be a number between 1 and 36500/)).toBeVisible();
  await page.keyboard.press("Meta+a");
  const good = '{ "trash": { "ttlDays": 20 } } // mine';
  await page.keyboard.type(good);
  await expect(dialog.getByText(/must be a number/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  // Comments included: the dialog saves the text, not a reserialization.
  expect(await page.evaluate(() => window.__harness.settingsText("server"))).toBe(good);
});

// Settings have two homes (remote.md §5) and the dialog has a tab per home.
// Three things have to hold at once, and each has its own way of going wrong:
// the tabs address different files, an untouched file is not rewritten just
// for being looked at, and switching tabs does not throw away typing.
test("the settings dialog edits both files, and switching tabs keeps what was typed", async ({ page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const serverBefore = await page.evaluate(() => window.__harness.settingsText("server"));

  // The server tab is the one that opens; the knobs there are the machine's.
  await expect(dialog.locator(".cm-content")).toContainText('"shell"');
  await dialog.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type('{ "trash": { "ttlDays": 5 } }');

  await dialog.getByRole("tab", { name: "This app" }).click();
  // A different file, with the knobs that describe a screen.
  await expect(dialog.locator(".cm-content")).toContainText('"fontSize"');
  await expect(dialog.locator(".cm-content")).not.toContainText('"shell"');
  await page.keyboard.press("Meta+a");
  await page.keyboard.type('{ "appearance": { "theme": "dark" } }');

  // Back, and the unsaved edit is still there: a tab is a view onto a file,
  // not a reload of it.
  await dialog.getByRole("tab", { name: "Notes machine" }).click();
  await expect(dialog.locator(".cm-content")).toContainText('"ttlDays": 5');

  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__harness.settingsText("server"))).toBe('{ "trash": { "ttlDays": 5 } }');
  expect(await page.evaluate(() => window.__harness.settingsText("client"))).toBe(
    '{ "appearance": { "theme": "dark" } }',
  );
  expect(serverBefore).not.toBe('{ "trash": { "ttlDays": 5 } }');
});

test("a tab that was only looked at is not rewritten", async ({ page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const clientBefore = await page.evaluate(() => window.__harness.settingsText("client"));
  await dialog.getByRole("tab", { name: "This app" }).click();
  await expect(dialog.locator(".cm-content")).toContainText('"fontSize"');
  await dialog.getByRole("tab", { name: "Notes machine" }).click();
  await dialog.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type('{ "trash": { "ttlDays": 8 } }');
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  // Byte-for-byte, comments and all: an install that deleted the template's
  // comments must not have them written back by a visit to the tab.
  expect(await page.evaluate(() => window.__harness.settingsText("client"))).toBe(clientBefore);
});

test("settings dialog: the caret is drawn, and ⌘C/⌘X/⌘V go through the clipboard bridge", async ({ page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.locator(".cm-content").click();
  // drawSelection paints the caret (the native one is invisible on the dark
  // surface); the element existing is what "you can see where you type" means.
  await expect(dialog.locator(".cm-cursor")).toHaveCount(1);

  const doc = '{ "trash": { "ttlDays": 9 } }';
  await page.keyboard.press("Meta+a");
  await page.keyboard.type(doc);
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  expect(await page.evaluate(() => window.__harness.clipboard())).toBe(doc);
  // Cut empties the doc; paste brings it back — the full round trip.
  await page.keyboard.press("Meta+x");
  await expect(dialog.locator(".cm-content")).not.toContainText("ttlDays");
  await page.keyboard.press("Meta+v");
  await expect(dialog.locator(".cm-content")).toContainText('"ttlDays": 9');
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
