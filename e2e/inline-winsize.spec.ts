// The run's shell is told the panel's width before its command runs. The view
// does not send them in that order: the run message goes out first
// (editor/blocks.ts startInlineRun), and the resize only once the output panel
// exists and its ResizeObserver fires. Bun stashes a resize that arrives
// before its runBlock and applies it before writing the runner line
// (InlinePool.pendingResize). A resize that landed after the first output
// would run the command at the pty's default width, and anything that lays out
// to COLUMNS would be wrong for that run.
//
// Whether a shell then lays its output out at the reported width needs a live
// probe (testing.md §6).
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

test("the panel reports its grid before the run has said anything", async ({ page }) => {
  const id = await runBlock(page);

  // No output has been pushed yet, and the shell already knows the width.
  await expect
    .poll(() => page.evaluate((r) => window.__harness.inlineResizes().filter((x) => x.id === r).length, id))
    .toBeGreaterThan(0);

  const first = await page.evaluate(
    (r) => window.__harness.inlineResizes().find((x) => x.id === r)!,
    id,
  );
  // The reported width is a measurement, not xterm's starting grid. xterm
  // opens at 2 columns (editor/inlineTerm.ts) and the fit grows it to the
  // editor's content width.
  expect(first.cols).toBeGreaterThan(20);
});

test("the terminal is measurable before it is visible, and takes no height", async ({ page }) => {
  // The ordering above rests on the host staying laid out before the first
  // byte: `.ledge-term-unshown` gives it zero height instead of hiding it.
  // With `display: none` the host has no width, so the fit bails and the
  // winsize goes out late while the panel still looks right
  // (editor/inlineTerm.ts).
  const id = await runBlock(page);
  const before = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".ledge-term-host")!;
    return { width: host.clientWidth, height: host.clientHeight, unshown: host.classList.contains("ledge-term-unshown") };
  });
  expect(before.unshown).toBe(true);
  expect(before.width).toBeGreaterThan(0);
  expect(before.height).toBe(0);

  // The first byte shows the terminal: the placeholder is removed and the host
  // takes height.
  await page.evaluate((r) => window.__harness.runOutput(r, "hi\r\n"), id);
  await expect(page.locator(".ledge-term-waiting")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.querySelector(".ledge-term-host")!.clientHeight))
    .toBeGreaterThan(0);
});
