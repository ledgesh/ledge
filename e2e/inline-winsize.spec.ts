// The run's shell is told the panel's width before its command runs.
//
// It used to be told afterwards. The terminal host was `display: none` until the
// first byte, so it had no laid-out width, the fit bailed, and the first winsize
// went out only once output had already arrived — by which point the command had
// run against the pty's default width. Everything that lays out to COLUMNS was
// wrong for exactly one run: zsh's own prompt padding (which is how this was
// found — a stray `%` under every block's output), a progress bar, `ls` picking
// its columns.
//
// The bytes on the other side belong to a live probe; what a spec can hold is
// the ordering, which is the whole of the view's half.
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
  // A real measurement, not the fallback: the panel spans the editor's content
  // width, which is far more than a couple of columns.
  expect(first.cols).toBeGreaterThan(20);
});

test("the terminal is measurable before it is visible, and takes no height", async ({ page }) => {
  // The mechanism the ordering above rests on. `display: none` would restore the
  // bug silently — the panel would still look right, and the winsize would just
  // go out late again.
  const id = await runBlock(page);
  const before = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".ledge-term-host")!;
    return { width: host.clientWidth, height: host.clientHeight, unshown: host.classList.contains("ledge-term-unshown") };
  });
  expect(before.unshown).toBe(true);
  expect(before.width).toBeGreaterThan(0);
  expect(before.height).toBe(0);

  // The first byte reveals it, and the placeholder goes with it.
  await page.evaluate((r) => window.__harness.runOutput(r, "hi\r\n"), id);
  await expect(page.locator(".ledge-term-waiting")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.querySelector(".ledge-term-host")!.clientHeight))
    .toBeGreaterThan(0);
});
