// App-level chrome: the three overlay modes (⌘P notes, ⇧⌘P commands, ⌥⌘P text
// search, crossed with `>`/`#` or the mode chips), ⌘⌫ as the chord form of
// delete, Empty Trash's confirmation, the settings dialog (two files, live
// validation, byte-for-byte saves, caret, clipboard), and modal suppression:
// while a layer is open, the window dispatcher is silent (interactions.md §6).
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// Reads the editor's selected text off the Range. WebKit's
// Selection.toString() can be empty for a selection CodeMirror set
// programmatically, while the Range always reports the text.
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
  // Wait for the hit row, because the results arrive debounced. [data-active]
  // is the overlay's highlighted row. The folder and connection pickers put
  // the attribute on every row of their own, so an unscoped locator works here
  // only because neither picker is open.
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
// The chips cross between modes on a client with no keyboard. The sigils were
// the only chordless crossing before them, and both `>` and `#` sit on the
// iPhone keyboard's third plane (123, then #+=): two plane switches to type
// one character, and a third tap back to letters. The chips help on a Mac too:
// a lit chip shows which mode is current, and crossing by chip keeps the query.
const chip = (page: Page, name: string) =>
  page.locator("div.fixed.inset-0.z-50").getByRole("button", { name: new RegExp(`^${name}`) });

test("a chip crosses modes and carries the query with it", async ({ page }) => {
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("gam");
  await chip(page, "Text").click();
  const field = page.getByPlaceholder("Search inside notes");
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("gam");
  // Crossing back keeps the query in the field, and keeps the field focused
  // for the next keystroke.
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
  // A phrase that no note has in its title and one note has in its body.
  // "No notes match" would be true and would not help, so the overlay
  // replaces that message with a row offering the text search (Overlay.tsx).
  await page.keyboard.type("beta body");
  await expect(page.locator("[data-crossing]")).toContainText("Search “beta body” in note text");
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Search inside notes")).toHaveValue("beta body");
  await expect(page.locator("[data-active]")).toContainText("beta body");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content").first()).toContainText("beta body");
});

test("a search hit on an already-open note focuses its tab and reveals the line", async ({ page }) => {
  // Open Beta first, then search for its body text. openNote must reuse the
  // tab rather than open one path twice, and the reveal must still land even
  // though the editor is not attached afresh.
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
  // A fresh install opens on the seeded template. Its comments are the
  // settings documentation, so this checks the dialog shows them.
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
// the tabs address different files, an untouched file is not rewritten for
// being opened, and switching tabs keeps what was typed. The test below covers
// the first and the third; the untouched-file rule is the test after it.
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

  // The unsaved edit survives the trip to the other tab and back. Switching
  // tabs changes which held text the editor shows, and does not re-read the
  // file (SettingsEditor.tsx).
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
  // Byte-for-byte, comments and all. If someone deleted the template's
  // comments from this file, opening its tab must not write them back.
  expect(await page.evaluate(() => window.__harness.settingsText("client"))).toBe(clientBefore);
});

test("settings dialog: the caret is drawn, and ⌘C/⌘X/⌘V go through the clipboard bridge", async ({ page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.locator(".cm-content").click();
  // The dialog draws its own caret with drawSelection rather than relying on
  // the native one, which CodeMirror's base theme styles for a light surface
  // (SettingsEditor.tsx). The .cm-cursor element is what drawSelection draws.
  await expect(dialog.locator(".cm-cursor")).toHaveCount(1);

  const doc = '{ "trash": { "ttlDays": 9 } }';
  await page.keyboard.press("Meta+a");
  await page.keyboard.type(doc);
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  expect(await page.evaluate(() => window.__harness.clipboard())).toBe(doc);
  // Cut empties the doc and paste brings it back, covering the round trip.
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
