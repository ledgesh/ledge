// Escape in the terminal drawer (interactions.md §6 layer 5). The drawer closes
// on the inline panel's rule, `escapeLeaves`: ⌘Escape always, Escape twice
// unless a full-screen program holds the alternate buffer. Every bare Escape
// still reaches the shell.
import { expect, test, type Page } from "@playwright/test";

const drawer = (page: Page) => page.locator(".xterm");
const escapesSent = (page: Page) =>
  page.evaluate(() => window.__harness.termInputs().filter((i) => atob(i.dataB64) === "\x1b").length);

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.getByTitle("Toggle Terminal", { exact: false }).click();
  await expect(drawer(page)).toBeVisible();
  // Input is sent only once the attach has answered (TerminalDrawer `mine`).
  await expect.poll(() => page.evaluate(() => window.__harness.termAttaches().length)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__harness.termResizes().length)).toBeGreaterThan(0);
});

test("one Escape goes to the shell and leaves the drawer open", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect.poll(() => escapesSent(page)).toBe(1);
  await expect(drawer(page)).toBeVisible();
});

test("Escape twice closes the drawer after the first reaches the shell", async ({ page }) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  expect(await escapesSent(page)).toBe(1);
});

test("⌘Escape closes the drawer and sends nothing", async ({ page }) => {
  await page.keyboard.press("Meta+Escape");
  await expect(drawer(page)).toHaveCount(0);
  expect(await escapesSent(page)).toBe(0);
});

test("a full-screen program keeps every Escape, and ⌘Escape still closes", async ({ page }) => {
  const sid = await page.evaluate(() => window.__harness.termAttaches().at(-1)!.sessionId);
  // What vim prints first: switch to the alternate screen buffer.
  await page.evaluate((s) => window.__harness.terminalOutput(s, "\x1b[?1049h"), sid);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect.poll(() => escapesSent(page)).toBe(2);
  await expect(drawer(page)).toBeVisible();

  await page.keyboard.press("Meta+Escape");
  await expect(drawer(page)).toHaveCount(0);
});

test("the double tap closes again once the program leaves the alternate buffer", async ({ page }) => {
  const sid = await page.evaluate(() => window.__harness.termAttaches().at(-1)!.sessionId);
  await page.evaluate((s) => window.__harness.terminalOutput(s, "\x1b[?1049h"), sid);
  await page.evaluate((s) => window.__harness.terminalOutput(s, "\x1b[?1049l"), sid);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
});
