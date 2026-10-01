// A run panel's terminal has a fixed pixel width until its next fit. Without
// containment on its host (index.css .ledge-term-host) that width held the
// editor's content at the old size when the window narrowed, so every line
// wrapped wide and was cut off at the window's edge.
import { expect, test } from "@playwright/test";

test("narrowing the window narrows the note at once, past a finished run", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8);
  await page.keyboard.insertText(`# Untitled\n\n${para}\n\n\`\`\`sh\necho 123\n\`\`\`\n\n${para}\n`);
  await page.locator(".cm-line", { hasText: "echo 123" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-output")).toBeVisible();
  const runs = await page.evaluate(() => window.__harness.inlineRuns());
  const id = runs[runs.length - 1].id;
  await page.evaluate((r) => window.__harness.runOutput(r, "123\r\n"), id);
  await page.evaluate((r) => window.__harness.runEnd(r, 0), id);
  await expect(page.locator(".ledge-output")).toContainText("123");

  for (const width of [1400, 1100, 900, 700, 600]) await page.setViewportSize({ width, height: 900 });
  // Measured straight away: the terminal's next fit would hide the bug.
  const widths = await page.evaluate(() => ({
    scroller: document.querySelector<HTMLElement>(".cm-scroller")!.clientWidth,
    content: document.querySelector<HTMLElement>(".cm-content")!.getBoundingClientRect().width,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.scroller);
});
