// The `keys` setting (interactions.md §2a): a chord the user assigned runs its
// command from the editor as well as the page, outranks CodeMirror's own
// binding for it, and is taken from the command that shipped with it.
// bindings.test.ts covers how the setting resolves; these specs cover the
// chords arriving, which only a real editor can show. The harness takes the
// section as `?keys=` JSON.
import { expect, test, type Page } from "@playwright/test";

const panes = (page: Page) => page.locator(".ledge-tabstrip");
const palette = (page: Page) => page.getByPlaceholder("Run a command");

// Boot with a `keys` section and land in a fresh note with the editor focused.
async function open(page: Page, keys: Record<string, string[]>, query = ""): Promise<void> {
  await page.goto(`/harness.html?keys=${encodeURIComponent(JSON.stringify(keys))}${query}`);
  const alpha = page.locator('[data-target-kind="note"]', { hasText: "Alpha" });
  await expect(alpha).toBeVisible();
  // From a row, as keyboard-ctrl.spec.ts does: under `?mod=ctrl` the harness's
  // CodeMirror still binds the Mac's own Ctrl+N in an editor.
  await alpha.click();
  await page.keyboard.press(query.includes("mod=ctrl") ? "Control+n" : "Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
}

// The document as written, read through the harness clipboard (testing.md §5).
async function raw(page: Page): Promise<string> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  return page.evaluate(() => window.__harness.clipboard());
}

test("a rebound chord runs its command, the old chord does nothing, and the chip follows", async ({ page }) => {
  await open(page, { "pane.splitRight": ["Mod-Alt-d"] });
  await page.keyboard.press("Meta+d");
  await expect(panes(page)).toHaveCount(1);
  await page.keyboard.press("Alt+Meta+d");
  await expect(panes(page)).toHaveCount(2);

  await page.keyboard.press("Shift+Meta+p");
  await page.keyboard.type("Split Right");
  await expect(page.getByText("⌥⌘D", { exact: true })).toBeVisible();
});

test("an assigned chord is taken from the editor command that had it", async ({ page }) => {
  await open(page, { "pane.splitRight": ["Mod-b"] });
  await page.keyboard.type("not bold");
  await page.keyboard.press("Shift+Meta+ArrowLeft");
  await page.keyboard.press("Meta+b");
  await expect(panes(page)).toHaveCount(2);

  // Bold has no chord left to advertise, and Split Right advertises ⌘B.
  await page.keyboard.press("Shift+Meta+p");
  await page.keyboard.type("Bold");
  await expect(page.getByText("Bold", { exact: true })).toBeVisible();
  await expect(page.getByText("⌘B", { exact: true })).toHaveCount(0);
});

test("a chord CodeMirror binds itself goes to the command it was given", async ({ page }) => {
  // ⌘/ is CodeMirror's toggle-comment. Assigned, it opens the palette and the
  // note is left as typed.
  await open(page, { "palette.commands": ["Mod-/"] });
  await page.keyboard.type("a line");
  await page.keyboard.press("Meta+/");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-content").first()).toHaveText("a line");
});

test("an editor command that ships with no chord takes one", async ({ page }) => {
  await open(page, { "editor.duplicateLine": ["Mod-Shift-d"] });
  await page.keyboard.type("one");
  await page.keyboard.press("Shift+Meta+d");
  expect(await raw(page)).toBe("one\none");
  // ⇧⌘D was Split Down, which lost it.
  await expect(panes(page)).toHaveCount(1);
});

test("where Mod is Ctrl, Ctrl+D can select the next occurrence instead of splitting", async ({ page }) => {
  // Issue #17's case, spelled the way a Ctrl desktop's chips print a chord.
  await open(page, { "editor.selectNextOccurrence": ["Ctrl+D"] }, "&mod=ctrl");
  await page.keyboard.type("foo bar foo");
  // The first press selects the word at the caret, the second adds the other.
  await page.keyboard.press("Control+d");
  await page.keyboard.press("Control+d");
  await page.keyboard.type("x");
  expect(await raw(page)).toBe("x bar x");
  await expect(panes(page)).toHaveCount(1);
});

test("a command left with no chord: the editor still builds, and its old chord is dead", async ({ page }) => {
  await open(page, { "terminal.toggle": [], "editor.save": [] });
  await page.keyboard.type("still typing");
  expect(await raw(page)).toBe("still typing");
  await page.keyboard.press("Control+`");
  await expect(page.locator(".xterm")).toHaveCount(0);
});

test("the settings dialog says what a keys entry got wrong", async ({ page }) => {
  await open(page, {});
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "This app" }).click();
  await dialog.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type('{ "keys": { "note.nwe": "Mod-e", "note.new": ["Mod-1", "d"] } }');
  await expect(dialog.getByText(/"keys.note.nwe" is not a command id/)).toBeVisible();
  await expect(dialog.getByText(/"Mod-1" is Switch to Workspace 1/)).toBeVisible();
  await expect(dialog.getByText(/"d" needs Mod, Ctrl or Alt/)).toBeVisible();
});

// The find keymap binds every chord of each command now, where it used to
// reach the shifted aliases through CodeMirror's `shift` field. With no
// setting at all, ⇧⌘F, ⌘G and ⇧⌘G must still arrive.
test("with no setting, the find aliases still arrive", async ({ page }) => {
  await open(page, {});
  await page.keyboard.type("x1 x2 x3");
  await page.keyboard.press("Shift+Meta+f");
  await expect(page.getByPlaceholder("Replace")).toBeVisible();
  await page.getByPlaceholder("Find").fill("x");
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Replace")).toHaveCount(0);

  // From the top: ⌘G takes the first match, ⌘G the second, ⇧⌘G wraps back
  // past the replaced first one to the last.
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Meta+g");
  await page.keyboard.type("A");
  await page.keyboard.press("Meta+g");
  await page.keyboard.press("Shift+Meta+g");
  await page.keyboard.type("B");
  expect(await raw(page)).toBe("A1 x2 B3");
});
