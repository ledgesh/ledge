// Frontmatter in the editor. The params block renders dimmed (line
// decorations in editor/frontmatter.ts). The note's title still comes from
// the first H1 after the block: headingOf skips the block, or every note
// carrying params would slug to "untitled" (shared/slug.ts). Also covers ⌥⌘,
// (editor/frontmatterEdit.ts), the fence auto-close (editor/fences.ts), and
// the in-block completion (editor/frontmatterComplete.ts).
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
  await page.keyboard.press("Meta+ArrowUp"); // ⌘↑ moves the caret to the top, so the block goes in above the H1
  for (const line of ["---", "profile: petstore", "---", "# Fm Note"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }

  // The dimming covers the block and nothing else: both fences and the one
  // params line, with nothing after the closing fence.
  const fmLines = page.locator(".cm-line.ledge-fm");
  await expect(fmLines).toHaveCount(3);
  await expect(page.locator(".cm-line.ledge-fm-fence")).toHaveCount(2);
  await expect(page.locator(".cm-line.ledge-fm", { hasText: "Fm Note" })).toHaveCount(0);

  // The tab takes its title from the H1 after the block (headingOf in
  // shared/slug.ts skips the block). The autosave debounce has to land first.
  await expect(page.locator("[data-tab]", { hasText: "Fm Note" })).toBeVisible();

  // The dimming goes as soon as the opening fence does: the decorations
  // rebuild on every doc change (editor/frontmatter.ts).
  await page.keyboard.press("Meta+ArrowUp"); // caret to doc start
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Backspace"); // deletes the opening fence
  await expect(page.locator(".cm-line.ledge-fm")).toHaveCount(0);
});

test("the profile editor round-trips a variable through the palette command", async ({ page }) => {
  // "Edit Note Profile…" shows only while the note names a profile
  // (profile.open's `when` in commands/registry.ts).
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+ArrowUp"); // ⌘↑ moves the caret to the top, so the block goes in above the H1
  for (const line of ["---", "profile: petstore", "---", "# Petstore calls"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }

  // Route one: the edit button after the profile name, in the overlay layer.
  // Typing the block leaves the caret below it, and the chip lights only on
  // hover or with the caret inside the block (blocks.ts, index.css). An unlit
  // chip has pointer-events: none, so the step dispatches mousedown on the
  // button rather than clicking it.
  const chip = page.locator('.ledge-ctl-group[data-block="fm"] .ledge-btn');
  await expect(chip).toBeVisible();
  await chip.dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByRole("dialog", { name: "Profile petstore" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Profile petstore" })).toBeHidden();

  // Route two: ⌘-click the profile name itself. A plain click stays a caret
  // move, since the name is editable text (clickToEdit in
  // editor/frontmatter.ts).
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

  // A fresh profile opens onto one blank row, and the value field is a
  // password input because profile values are secrets.
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
  // No block yet, so the palette entry reads Add.
  await page.keyboard.press("Meta+Shift+P");
  await page.keyboard.type("frontmatter");
  await expect(page.getByText("Add Frontmatter")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Alt+Meta+,");
  await expect(page.locator(".cm-line.ledge-fm-fence")).toHaveCount(2);
  // The caret landed on the body line between the fences, so typing lands in
  // the block. The key completion pops; Escape dismisses it and leaves the
  // typed text.
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
  // The Enter planted the closing fence. The caret sits between the two
  // fences.
  await expect(page.locator(".cm-line.ledge-fm-fence")).toHaveCount(2);
  await page.keyboard.type("tags");
  await page.keyboard.press("Escape"); // dismiss the key popup: typing, not picking
  await expect(page.locator(".cm-line.ledge-fm", { hasText: "tags" })).toBeVisible();

  // A code fence below the frontmatter. The third backtick plants the closer
  // (typedFence in editor/fences.ts), so this Enter only opens a blank line
  // inside the block it made. Both fence lines show their marks because the
  // caret is inside that block (editor/livePreview.ts reveals what the
  // selection touches).
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

  // Key position. Each option carries a one-line hint, and the hints are
  // where the grammar is written down (KEY_OPTIONS in
  // editor/frontmatterComplete.ts). That is what the exact hint text below
  // asserts. Accepting the option writes the colon too.
  const popup = page.locator(".cm-tooltip-autocomplete");
  await page.keyboard.type("te");
  await expect(popup).toBeVisible();
  await expect(popup.locator("li", { hasText: "template" })).toContainText("daily seeds ⌘J");
  await completionAcceptReady(page, popup);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line.ledge-fm", { hasText: "template:" })).toBeVisible();

  // Value position. After the colon the popup offers the three values
  // `template` accepts (TEMPLATE_VALUES in editor/frontmatterComplete.ts).
  await page.keyboard.type("d");
  await expect(popup).toBeVisible();
  await completionAcceptReady(page, popup);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line.ledge-fm", { hasText: "template: daily" })).toBeVisible();
});

test("a line the parser cannot read says so beside itself, and stops once fixed", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("---");
  await page.keyboard.press("Enter"); // autoclose plants the closing fence
  await page.keyboard.type("template: yes");
  await page.keyboard.press("Escape"); // dismiss the value popup: typing, not picking

  // The message names the typo and is drawn at the end of the line that
  // carries it. The line itself is accented too. On a narrow window, where
  // the message wraps below, the accent is what ties it to its own line.
  const problem = page.locator(".ledge-fm-problem");
  await expect(problem).toHaveText(`"template" must be true, false, or daily: "yes"`);
  await expect(page.locator(".cm-line.ledge-fm-bad")).toHaveCount(1);
  // The typed text is still on the line, with the message drawn after it.
  await expect(page.locator(".cm-line.ledge-fm-bad")).toContainText("template: yes");

  // Fixing the line clears the annotation, on the same rebuild the dimming
  // gets whenever the doc changes. The annotation is advisory: nothing is
  // blocked or refused.
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Backspace");
  await page.keyboard.type("true");
  await page.keyboard.press("Escape");
  await expect(problem).toHaveCount(0);
  await expect(page.locator(".cm-line.ledge-fm-bad")).toHaveCount(0);
  await expect(page.locator(".cm-line.ledge-fm")).toHaveCount(3);
});

test("a line wrong twice over annotates once, with both reasons", async ({ page }) => {
  // Each bad token is refused on its own, so a bad tag does not take down the
  // tags beside it. One line still gets one annotation, joining both messages
  // (build in editor/frontmatter.ts). A stack of messages on one short line
  // would cover the block.
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("---");
  await page.keyboard.press("Enter");
  await page.keyboard.type("tags: 123 456 work");
  await page.keyboard.press("Escape");

  const problem = page.locator(".ledge-fm-problem");
  await expect(problem).toHaveCount(1);
  await expect(problem).toContainText(`"123"`);
  await expect(problem).toContainText(`"456"`);
  // The tag beside them survived, and is styled as one.
  await expect(page.locator(".ledge-fm-tag")).toHaveText("work");
});

test("profile fields copy and paste through the clipboard bridge, mask notwithstanding", async ({ page }) => {
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+ArrowUp"); // ⌘↑ moves the caret to the top, so the block goes in above the H1
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
