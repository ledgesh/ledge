// The output panel is the lower half of its code block's card, not a terminal
// parked beneath it.
//
// The whole treatment rests on one structural fact: CodeMirror renders a block
// widget as the immediate next sibling of the line it is anchored to, so the CSS
// can pair a panel with its block using `.ledge-code-attached + .ledge-output`.
// If a CodeMirror upgrade ever puts something between them (a buffer element, a
// wrapper), the fusing silently reverts to two boxes and nothing else fails —
// hence the first spec, which asserts the adjacency itself rather than only what
// it produces.
import { expect, test } from "@playwright/test";

async function runBlock(page: import("@playwright/test").Page) {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Untitled\n\n```sh\necho hi\n```\n");
  await page.locator(".cm-line", { hasText: "echo hi" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-output")).toBeVisible();
  const runs = await page.evaluate(() => window.__harness.inlineRuns());
  return runs[runs.length - 1].id;
}

test("the panel is the closing fence's immediate sibling, and knows it", async ({ page }) => {
  await runBlock(page);

  // The closing fence stops closing the card once a panel is under it.
  await expect(page.locator(".ledge-code-attached")).toHaveCount(1);
  await expect(page.locator(".ledge-code-bottom")).toHaveCount(0);

  // The adjacency the CSS depends on.
  const adjacent = await page.evaluate(() => {
    const panel = document.querySelector(".ledge-output");
    return panel?.previousElementSibling?.classList.contains("ledge-code-attached") ?? false;
  });
  expect(adjacent).toBe(true);
});

test("the two halves line up as one card", async ({ page }) => {
  await runBlock(page);

  const geom = await page.evaluate(() => {
    const fence = document.querySelector<HTMLElement>(".ledge-code-attached")!;
    const panel = document.querySelector<HTMLElement>(".ledge-output")!;
    const f = fence.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const s = getComputedStyle(panel);
    return {
      dLeft: Math.abs(f.left - p.left),
      dRight: Math.abs(f.right - p.right),
      gap: p.top - f.bottom,
      topBorder: s.borderTopWidth,
      topRadius: s.borderTopLeftRadius,
    };
  });

  // Flush edges, no gap, and the panel contributes no second top edge: the seam
  // is the header's border, drawn inside.
  expect(geom.dLeft).toBeLessThanOrEqual(1);
  expect(geom.dRight).toBeLessThanOrEqual(1);
  expect(Math.abs(geom.gap)).toBeLessThanOrEqual(1);
  expect(geom.topBorder).toBe("0px");
  expect(geom.topRadius).toBe("0px");
});

test("a panel with no block above it stays a free-standing box", async ({ page }) => {
  await runBlock(page);
  // Delete the block out from under the panel. What is left cannot be the lower
  // half of anything, so it goes back to being its own bordered card rather than
  // a lidless box floating in prose.
  await page.locator(".cm-line", { hasText: "echo hi" }).click();
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Shift");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Untitled\n\njust prose\n");

  await expect(page.locator(".ledge-output")).toBeVisible();
  await expect(page.locator(".ledge-code-attached")).toHaveCount(0);
  const topBorder = await page.evaluate(
    () => getComputedStyle(document.querySelector<HTMLElement>(".ledge-output")!).borderTopWidth,
  );
  expect(topBorder).toBe("1px");
});
