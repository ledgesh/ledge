// The Ctrl keyboard grammar, which a Linux desktop gets (interactions.md §2,
// commands/modKey.ts): Mod is Ctrl, the tab jump is Alt+1…9, the terminal
// keeps plain Ctrl for its shell, chips spell Ctrl+…, and Quit is a command.
// The harness runs it under `?mod=ctrl` in a WebKit that harness.html makes
// a Mac on every host, which is as close as the suite gets to the keyboard a
// Linux window sees. The editor's own chords are CodeMirror's and follow
// navigator.platform, so they are not part of this spec; and since CodeMirror
// binds the Mac's emacs-style Ctrl+N/P (line up and down) here, which a Linux
// build never does, every chord below is pressed with focus on a list row
// rather than in the editor.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) => page.locator('[data-target-kind="note"]', { hasText: title });
const tabs = (page: Page) => page.locator("[data-tab]");
const activeTab = (page: Page) => page.locator("[data-tab].bg-background");
const palette = (page: Page) => page.getByPlaceholder("Run a command");

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html?mod=ctrl");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await noteRow(page, "Alpha").click();
});

test("Ctrl+N opens a note, and Super+N does not", async ({ page }) => {
  const before = await tabs(page).count();
  await page.keyboard.press("Meta+n");
  await expect(tabs(page)).toHaveCount(before);
  await page.keyboard.press("Control+n");
  await expect(tabs(page)).toHaveCount(before + 1);
});

test("the palette opens on Ctrl+Shift+P and spells its chips with Ctrl", async ({ page }) => {
  await page.keyboard.press("Control+Shift+p");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type("Close Tab");
  await expect(page.getByText("Ctrl+W", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
});

test("Alt+N jumps to a tab, where a Mac would use Control+N", async ({ page }) => {
  await page.keyboard.press("Control+n");
  await page.keyboard.press("Control+n");
  await expect(activeTab(page)).toHaveText(/Untitled/);
  await page.keyboard.press("Alt+1");
  await expect(activeTab(page)).not.toHaveText(/Untitled/);
  await expect(tabs(page).first()).toHaveClass(/bg-background/);
  // Control+1 is not the tab jump here: Ctrl+1 is the workspace jump.
  await page.keyboard.press("Alt+2");
  await expect(tabs(page).nth(1)).toHaveClass(/bg-background/);
});

test("the terminal keeps plain Ctrl chords for its shell; Ctrl+Shift reaches the app", async ({ page }) => {
  await page.keyboard.press("Control+n");
  const count = await tabs(page).count();
  await page.keyboard.press("Control+`");
  await expect(page.locator(".xterm")).toBeVisible();
  await page.locator(".xterm-screen").click();
  // Ctrl+W is Close Tab everywhere else. In the terminal it is the shell's
  // delete-word, so the tab stays.
  await page.keyboard.press("Control+w");
  await expect(tabs(page)).toHaveCount(count);
  // Ctrl+Shift+P is a chord no shell can hear apart from Ctrl+P, so the app
  // keeps it, from the terminal too.
  await page.keyboard.press("Control+Shift+p");
  await expect(palette(page)).toBeVisible();
});

test("Quit Ledge is a palette command that asks the shell to quit", async ({ page }) => {
  await page.keyboard.press("Control+Shift+p");
  await page.keyboard.type("Quit Ledge");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.quitAsks())).toBe(1);
});

// The manual is written in the Mac's glyphs and read through respellChords
// (commands/format.ts, notes/channel.ts readNote), so the page a Ctrl desktop
// opens says Ctrl+Enter where the corpus says ⌘↩.
test("the manual reads in the Ctrl spelling", async ({ page }) => {
  await page.goto("/harness.html?docs=1&mod=ctrl");
  await expect(page.locator(".cm-line").first()).toHaveText("# Getting Started");
  await expect(page.locator(".cm-content")).toContainText("Ctrl+Enter runs the block.");
  await expect(page.locator(".cm-content")).not.toContainText("⌘");
});
