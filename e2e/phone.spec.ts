// The phone: the same view at 390x844, with touch and no chords (ios.md §6,
// §13). One claim is under test — a phone-sized client can reach every verb —
// spelled out on the two surfaces that carry it: the menu a long press opens
// on any row, and the overlay the chrome's own control opens. Everything the
// desktop suite asserts about the verbs themselves still holds; what a phone
// changes is how you get to them.
//
// The project is `phone` in playwright.config.ts, and it runs this file only.
import { expect, test, type Locator, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// A finger held on a row. Playwright's touchscreen can tap and nothing else,
// so the press is dispatched: pointerdown at the row's middle, then — once the
// menu has had its 500ms to appear — the pointerup and the click WebKit sends
// after every touch, which is the click the row must NOT act on.
async function pressAndHold(row: Locator): Promise<void> {
  const box = await row.boundingBox();
  if (!box) throw new Error("no box to press");
  const at = {
    pointerType: "touch",
    isPrimary: true,
    bubbles: true,
    clientX: Math.round(box.x + box.width / 2),
    clientY: Math.round(box.y + box.height / 2),
  };
  await row.dispatchEvent("pointerdown", at);
  await expect(row.page().getByRole("menu")).toBeVisible();
  await row.dispatchEvent("pointerup", at);
  await row.dispatchEvent("click", at);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("a tap focuses the row it lands on: the verbs have a subject again", async ({ page }) => {
  // R5's roving focus is what every row verb addresses, and a phone has no
  // hover to hint at it beforehand. The tapped row is the focused row.
  await noteRow(page, "Beta").tap();
  await expect(noteRow(page, "Beta")).toBeFocused();
  await expect(page.locator(".cm-content").first()).toContainText("beta body");
});

test("a long press opens the row's menu, and does not also open the note", async ({ page }) => {
  await noteRow(page, "Alpha").tap();
  const tabs = await page.locator("[data-tab]").count();
  await pressAndHold(noteRow(page, "Gamma"));
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Delete/ })).toBeVisible();
  // The press was a question about Gamma, not an instruction to open it: the
  // click that follows a touch is swallowed, so Alpha is still the note.
  await expect(page.locator("[data-tab]")).toHaveCount(tabs);
  await expect(page.locator(".cm-content").first()).toContainText("alpha body");
  // And the press left the focus ring on the row the menu is about (§6).
  await expect(noteRow(page, "Gamma")).toBeFocused();
});

test("the long press is the only way to Copy Path, and it works", async ({ page }) => {
  // Copy Path has no chord and no palette entry — it acts on a specific row,
  // so the row's menu is its whole home (R2/R6). On a phone that means it
  // exists if and only if the long press does.
  await pressAndHold(noteRow(page, "Beta"));
  await page.getByRole("menuitem", { name: "Copy Path" }).tap();
  expect(await page.evaluate(() => window.__harness.clipboard())).toContain("beta");
});

test("Delete runs from the menu, undoably, with no accelerator anywhere near it", async ({ page }) => {
  await pressAndHold(noteRow(page, "Alpha"));
  await page.getByRole("menuitem", { name: /Delete/ }).tap();
  await expect(noteRow(page, "Alpha")).toHaveCount(0);
  // Reversible destruction offers Undo instead of a prompt (§4), and the strip
  // is a tap target like any other.
  await page.getByRole("button", { name: "Undo" }).tap();
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("Delete Permanently keeps its confirmation and loses its accelerator", async ({ page }) => {
  await page.getByRole("button", { name: /^Trash/ }).tap();
  const trashRow = page.locator('[data-target-kind="trash"]').first();
  await pressAndHold(trashRow);
  await page.getByRole("menuitem", { name: /Delete Permanently/ }).tap();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("cannot be undone");
  // §4: focus lands on Cancel, and the phone changes nothing about that.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Delete Permanently" }).tap();
  await expect(page.locator('[data-target-kind="trash"]')).toHaveCount(0);
});

test("a menu opened at the bottom of the screen opens entirely on it", async ({ page }) => {
  // ios.md §13's second failure: "a row menu that opens off screen". It needs
  // a list long enough to reach the bottom of the phone, which the seeded four
  // notes are not — so seed a screenful and press the last one, where a menu
  // that hangs downward has nowhere to hang.
  await page.evaluate(() => {
    for (let i = 1; i <= 30; i++) window.__harness.store.seed("/harness/scratch", `# Zeta ${i}\n`);
    window.__harness.notesChanged("/harness/scratch");
  });
  const rows = page.locator('[data-target-kind="note"]');
  await expect(rows).toHaveCount(34);
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  const rowBox = await last.boundingBox();
  const view = page.viewportSize()!;
  expect(rowBox!.y).toBeGreaterThan(view.height * 0.75); // the case is real

  await pressAndHold(last);
  const menu = (await page.getByRole("menu").boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(0);
  expect(menu.y + menu.height).toBeLessThanOrEqual(view.height);
  expect(menu.x).toBeGreaterThanOrEqual(0);
  expect(menu.x + menu.width).toBeLessThanOrEqual(view.width);
  // Above the finger, not merely shoved up the screen: the row the menu is
  // about stays visible.
  expect(menu.y + menu.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height);
});

test("a workspace row's menu carries its verbs, Rename included", async ({ page }) => {
  await pressAndHold(page.locator('[data-target-kind="workspace"]').first());
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Rename Workspace…" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Close Workspace" })).toBeVisible();
  // Double-click is the desktop accelerator for a rename; the menu item is the
  // path R3 already called the discoverable one, and the only one here.
  await menu.getByRole("menuitem", { name: "Rename Workspace…" }).tap();
  // The inline field, not the editor's contenteditable: an <input> in the row.
  await expect(page.locator('[data-target-kind="workspace"] input')).toBeFocused();
});

test("a tab is a row too: its menu is where Close Tab lives without ⌘W", async ({ page }) => {
  await noteRow(page, "Alpha").tap();
  await noteRow(page, "Beta").tap();
  const tabs = page.locator("[data-tab]");
  const open = await tabs.count();
  expect(open).toBeGreaterThan(1);
  await pressAndHold(tabs.first());
  await page.getByRole("menuitem", { name: "Close Tab" }).tap();
  await expect(tabs).toHaveCount(open - 1);
});

test("the chrome's control opens quick-open, which is the way to every note", async ({ page }) => {
  await page.getByRole("button", { name: /Go to Note/ }).tap();
  await page.keyboard.type("gam");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content").first()).toContainText("gamma body");
});

test("and `>` inside it is the way to every command", async ({ page }) => {
  // The chord ⇧⌘P does not exist here. The control opens the overlay and its
  // own placeholder teaches the crossing, which is what keeps one button
  // enough for all three modes.
  await page.getByRole("button", { name: /Go to Note/ }).tap();
  await expect(page.getByPlaceholder(/> commands/)).toBeVisible();
  await page.keyboard.type(">toggle sidebar");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Workspaces")).toBeHidden();
});

test("a verb that only ever had a chord is reachable from the palette: Split Right", async ({ page }) => {
  await page.getByRole("button", { name: /Go to Note/ }).tap();
  await page.keyboard.type(">split right");
  await page.keyboard.press("Enter");
  // Two panes on a 390pt screen is a bad idea and a reachable one; what this
  // asserts is the reachability. What a phone SHOWS is the Swift shell's
  // problem (ios.md §14 phase 3), not the registry's.
  await expect(page.locator(".cm-editor")).toHaveCount(2);
});

test("Empty Trash: confirmed, from the palette, with nothing bound to a key", async ({ page }) => {
  await page.getByRole("button", { name: /Go to Note/ }).tap();
  await page.keyboard.type(">empty trash");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Empty the trash?");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Empty Trash" }).tap();
  await expect(page.getByRole("button", { name: /^Trash/ })).toHaveCount(0);
});
