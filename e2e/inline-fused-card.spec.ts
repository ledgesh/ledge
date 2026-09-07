// The output panel is the lower half of its code block's card, not a terminal
// parked beneath it (index.css, "The fused card"; editor/blocks.ts).
//
// The CSS fuses the two with `.ledge-code-attached + .ledge-output`. That works
// only while CodeMirror renders a block widget as the next sibling of its
// anchor line. An element between them would break the fusing with no error:
// the code card loses its bottom edge and the panel sits below it as a separate
// box. The first spec checks the adjacency directly.
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

  // With a panel under it, the closing fence carries `.ledge-code-attached`
  // instead of `.ledge-code-bottom`. It stops drawing the card's bottom edge.
  await expect(page.locator(".ledge-code-attached")).toHaveCount(1);
  await expect(page.locator(".ledge-code-bottom")).toHaveCount(0);

  // The CSS pairs with a sibling combinator, so the fusing holds only while the
  // panel is the fence's next element sibling.
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

  // The panel's edges line up with the fence's, with no gap between them. The
  // panel draws no top border or corner rounding of its own: the seam is the
  // header's top border, inside the panel.
  expect(geom.dLeft).toBeLessThanOrEqual(1);
  expect(geom.dRight).toBeLessThanOrEqual(1);
  expect(Math.abs(geom.gap)).toBeLessThanOrEqual(1);
  expect(geom.topBorder).toBe("0px");
  expect(geom.topRadius).toBe("0px");
});

test("a panel with no block above it stays a free-standing box", async ({ page }) => {
  await runBlock(page);
  // The ⌘A and the insertText below replace the whole document, so the
  // selection keystrokes above them do not affect what gets deleted. Replacing
  // the document removes the block and leaves the run's panel behind. Nothing
  // before the panel carries `.ledge-code-attached` then, and the CSS leaves it
  // free-standing with its own top border.
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
