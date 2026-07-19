// Frontmatter in the editor: the params block renders dimmed (editor/
// frontmatter.ts line decorations), and the note's title still comes from the
// first H1 AFTER the block — typing frontmatter must never rename a note to
// "---" or to untitled. Plus the block's front door (⌥⌘, — editor/
// frontmatterEdit.ts), the fence auto-close (editor/fences.ts), and the
// in-block completion (editor/frontmatterComplete.ts).
import { expect, test, type Locator, type Page } from "@playwright/test";

// Wait until the popup accepts Enter (see wikilinks.spec.ts for the full
// story: the disabled re-query window plus the 75ms interactionDelay).
const completionAcceptReady = async (page: Page, popup: Locator) => {
  await expect(popup).not.toHaveClass(/cm-tooltip-autocomplete-disabled/);
  await page.waitForTimeout(100);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
});

test("a typed frontmatter block dims, and the H1 behind it still titles the tab", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  for (const line of ["---", "profile: petstore", "---", "# Fm Note"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }

  // Exactly the block is dimmed: both fences, the one params line, and
  // nothing after the closing fence.
  const fmLines = page.locator(".cm-line.ledge-fm");
  await expect(fmLines).toHaveCount(3);
  await expect(page.locator(".cm-line.ledge-fm-fence")).toHaveCount(2);
  await expect(page.locator(".cm-line.ledge-fm", { hasText: "Fm Note" })).toHaveCount(0);

  // The tab takes its title from the H1 behind the block (slug.ts skips it) —
  // the autosave debounce has to land first.
  await expect(page.locator("[data-tab]", { hasText: "Fm Note" })).toBeVisible();

  // Deleting the opening fence un-dims live: the field rebuilds on doc change.
  await page.keyboard.press("Meta+ArrowUp"); // caret to doc start
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Backspace"); // opening fence gone: no block
  await expect(page.locator(".cm-line.ledge-fm")).toHaveCount(0);
});

test("the profile editor round-trips a variable through the palette command", async ({ page }) => {
  // A note naming a profile is what makes "Edit Note Profile…" exist at all.
  await page.keyboard.press("Meta+n");
  for (const line of ["---", "profile: petstore", "---", "# Petstore calls"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }

  // Route one: the edit button pinned after the profile name (the overlay
  // layer, where the pointer cursor works). The caret is inside the block
  // from typing it, so the button is revealed without needing a hover.
  const chip = page.locator('.ledge-ctl-group[data-block="fm"] .ledge-btn');
  await expect(chip).toBeVisible();
  await chip.dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByRole("dialog", { name: "Profile petstore" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Profile petstore" })).toBeHidden();

  // Route two: ⌘-click the profile name itself (the accelerator; a plain
  // click stays a caret move — the name is editable text).
  const profileLink = page.locator(".ledge-fm-profile");
  await expect(profileLink).toBeVisible();
  await profileLink.click({ modifiers: ["Meta"] });
  await expect(page.getByRole("dialog", { name: "Profile petstore" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Profile petstore" })).toBeHidden();

  // Route three: the palette command. All land on the same dialog.
  await page.keyboard.press("Meta+Shift+P");
  await page.keyboard.type("edit note profile");
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Profile petstore" });
  await expect(dialog).toBeVisible();

  // A fresh profile opens onto one blank row; values type masked (they are
  // secrets — that is the whole reason profiles exist).
  const keyField = dialog.getByLabel("Variable name").first();
  const valueField = dialog.getByLabel("Variable value").first();
  await expect(valueField).toHaveAttribute("type", "password");
  await keyField.fill("API_KEY");
  await valueField.fill("sk-123");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // Reopen: the save landed and parses back into the same row.
  await page.keyboard.press("Meta+Shift+P");
  await page.keyboard.type("edit note profile");
  await page.keyboard.press("Enter");
  const reopened = page.getByRole("dialog", { name: "Profile petstore" });
  await expect(reopened.getByLabel("Variable name").first()).toHaveValue("API_KEY");
  await expect(reopened.getByLabel("Variable value").first()).toHaveValue("sk-123");

  // A bad name blocks Save (it could never reach a shell), and Escape closes
  // through the layer stack.
  await reopened.getByLabel("Variable name").first().fill("9 bad name");
  await expect(reopened.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(reopened).toBeHidden();
});

test("⌥⌘, creates the block with the caret inside; the palette face flips to Edit", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  // No block yet: the palette says what will happen — Add.
  await page.keyboard.press("Meta+Shift+P");
  await page.keyboard.type("frontmatter");
  await expect(page.getByText("Add Frontmatter")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Alt+Meta+,");
  await expect(page.locator(".cm-line.ledge-fm-fence")).toHaveCount(2);
  // The caret landed on the body line between the fences: typing lands in
  // the block (and pops the key completion — dismissed, it is just typing).
  await page.keyboard.type("cwd");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-line.ledge-fm", { hasText: "cwd" })).toBeVisible();

  // With a block, the same chord's face is Edit.
  await page.keyboard.press("Meta+Shift+P");
  await page.keyboard.type("frontmatter");
  await expect(page.getByText("Edit Frontmatter")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Enter closes an unterminated fence: line-1 --- and ``` openers alike", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("---");
  await page.keyboard.press("Enter");
  // The closing fence arrived with the Enter; the caret sits between.
  await expect(page.locator(".cm-line.ledge-fm-fence")).toHaveCount(2);
  await page.keyboard.type("tags");
  await page.keyboard.press("Escape"); // the key popup — typing, not picking
  await expect(page.locator(".cm-line.ledge-fm", { hasText: "tags" })).toBeVisible();

  // A code fence below the block: Enter after the opener closes it in place
  // (both fences revealed, because the caret is inside the block).
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("```sh");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line.ledge-code-top")).toHaveText("```sh");
  await expect(page.locator(".cm-line.ledge-code-bottom")).toHaveText("```");
});

test("the block completes its keys and values, hints attached", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("---");
  await page.keyboard.press("Enter");

  // Key position: the option carries its one-line hint — the popup is the
  // documentation — and accepting writes the colon too.
  const popup = page.locator(".cm-tooltip-autocomplete");
  await page.keyboard.type("te");
  await expect(popup).toBeVisible();
  await expect(popup.locator("li", { hasText: "template" })).toContainText("daily seeds ⌘J");
  await completionAcceptReady(page, popup);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line.ledge-fm", { hasText: "template:" })).toBeVisible();

  // Value position: the grammar's own values complete in place.
  await page.keyboard.type("d");
  await expect(popup).toBeVisible();
  await completionAcceptReady(page, popup);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line.ledge-fm", { hasText: "template: daily" })).toBeVisible();
});

test("profile fields copy and paste through the clipboard bridge, mask notwithstanding", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  for (const line of ["---", "profile: petstore", "---", "# Petstore calls"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Meta+Shift+P");
  await page.keyboard.type("edit note profile");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Profile petstore" });
  const keyField = dialog.getByLabel("Variable name").first();
  const valueField = dialog.getByLabel("Variable value").first();

  // ⌘C on a selection in the name field lands on the bridge clipboard…
  await keyField.fill("TOKEN");
  await keyField.press("Meta+a");
  await keyField.press("Meta+c");
  expect(await page.evaluate(() => window.__harness.clipboard())).toBe("TOKEN");

  // …and ⌘V drops it into the (masked) value field: pasting a secret must
  // not require revealing it first.
  await valueField.click();
  await valueField.press("Meta+v");
  await expect(valueField).toHaveValue("TOKEN");

  // ⌘X cuts: the field empties and the clipboard holds the old value.
  await valueField.press("Meta+a");
  await valueField.press("Meta+x");
  await expect(valueField).toHaveValue("");
  expect(await page.evaluate(() => window.__harness.clipboard())).toBe("TOKEN");
});
