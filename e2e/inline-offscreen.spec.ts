// CodeMirror draws only the part of a note near the screen, and removes a
// widget that leaves it. The run panel's terminal is pooled by run id and
// outlives its widget (editor/blocks.ts terminalLifetime), so a panel that
// scrolls away and back, or a narrowed window that pushes it out of the drawn
// part, still has its output.
import { expect, test, type Page } from "@playwright/test";

const scroller = (page: Page, top: number) =>
  page.evaluate((t) => { document.querySelector(".cm-scroller")!.scrollTop = t; }, top);

async function runAboveLongNote(page: Page): Promise<string> {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  const filler = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} lorem ipsum dolor sit amet.`).join("\n\n");
  await page.keyboard.insertText(`# Untitled\n\n\`\`\`sh\necho 123\n\`\`\`\n\n${filler}\n`);
  await scroller(page, 0);
  await page.locator(".cm-line", { hasText: "echo 123" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-output")).toBeVisible();
  const runs = await page.evaluate(() => window.__harness.inlineRuns());
  return runs[runs.length - 1].id;
}

test("a finished run keeps its output after scrolling out of view and back", async ({ page }) => {
  const id = await runAboveLongNote(page);
  await page.evaluate((r) => window.__harness.runOutput(r, "123\r\n"), id);
  await page.evaluate((r) => window.__harness.runEnd(r, 0), id);
  await expect(page.locator(".ledge-output")).toContainText("123");

  await scroller(page, 1e7);
  await expect(page.locator(".ledge-output")).toHaveCount(0);
  await scroller(page, 0);
  await expect(page.locator(".ledge-output")).toContainText("Done");
  await expect(page.locator(".ledge-output")).toContainText("123");
  await expect(page.locator(".ledge-term-waiting")).toHaveCount(0);
});

test("output that arrives while the panel is scrolled away is there when it comes back", async ({ page }) => {
  const id = await runAboveLongNote(page);
  await scroller(page, 1e7);
  await expect(page.locator(".ledge-output")).toHaveCount(0);
  await page.evaluate((r) => window.__harness.runOutput(r, "late\r\n"), id);
  await page.evaluate((r) => window.__harness.runEnd(r, 0), id);

  await scroller(page, 0);
  await expect(page.locator(".ledge-output")).toContainText("Done");
  await expect(page.locator(".ledge-output")).toContainText("late");
});
