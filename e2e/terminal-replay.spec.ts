// Reopening the terminal drawer replays the shell's scrollback into a new
// xterm. The scrollback holds the queries programs sent when they ran, and
// xterm answers a query through the same path as a keystroke. The answers to
// replayed queries must not reach the shell, where they would be typed at the
// prompt.
import { expect, test, type Page } from "@playwright/test";

const drawer = (page: Page) => page.locator(".xterm");
const inputs = (page: Page) =>
  page.evaluate(() => window.__harness.termInputs().map((i) => atob(i.dataB64)));
// What vim asks a terminal as it starts: the cursor position, the terminal's
// version, the background color, and whether the cursor blinks.
const QUERIES = "\x1b[6n\x1b[>c\x1b]11;?\x07\x1b[?12$p";

async function openDrawer(page: Page): Promise<string> {
  const before = await page.evaluate(() => window.__harness.termAttaches().length);
  await page.getByTitle("Toggle Terminal", { exact: false }).click();
  await expect(drawer(page)).toBeVisible();
  // Input is sent only once the attach has answered (TerminalDrawer `mine`).
  await expect.poll(() => page.evaluate(() => window.__harness.termAttaches().length)).toBeGreaterThan(before);
  await expect.poll(() => page.evaluate(() => window.__harness.termResizes().at(-1)?.afterAttach)).toBeGreaterThan(before);
  return page.evaluate(() => window.__harness.termAttaches().at(-1)!.sessionId);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
});

test("a query from a running program is answered", async ({ page }) => {
  const sid = await openDrawer(page);
  await page.evaluate(([s, q]) => window.__harness.terminalOutput(s, q), [sid, QUERIES] as const);
  await expect.poll(async () => (await inputs(page)).join("")).toContain("\x1b[?12;");
});

test("a query in the replayed scrollback is not answered again", async ({ page }) => {
  const sid = await openDrawer(page);
  await page.keyboard.press("Meta+Escape");
  await expect(drawer(page)).toHaveCount(0);

  await page.evaluate(([s, q]) => window.__harness.shellHistory(s, `ran vim${q}\r\n$ `), [sid, QUERIES] as const);
  await openDrawer(page);
  await expect(drawer(page)).toContainText("ran vim");
  expect(await inputs(page)).toEqual([]);

  // The drawer still takes what is typed once the replay is done.
  await page.keyboard.type("ls");
  await expect.poll(() => inputs(page)).toEqual(["l", "s"]);
});
