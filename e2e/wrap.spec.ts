// Hanging indent (editor/wrap.ts). The column arithmetic is pure
// (wrap.test.ts); what only real WebKit can answer is whether the decoration
// lands where it should — the inline style composes with CodeMirror's own
// .cm-line padding rather than replacing it, which is exactly what an inline
// `padding-left` got wrong (list lines drew a marker's worth left of prose).
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await page.keyboard.press("Meta+a");
});

// The x of each line's first visible glyph, in absolute pixels.
const glyphLefts = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".cm-content .cm-line")].map((line) => {
      let x: number | null = null;
      const walk = (n: Node) => {
        if (x !== null) return;
        const text = n.textContent ?? "";
        if (n.nodeType === Node.TEXT_NODE && text.trim()) {
          const r = new Range();
          r.setStart(n, text.length - text.trimStart().length);
          r.setEnd(n, text.length);
          x = r.getBoundingClientRect().left;
          return;
        }
        n.childNodes.forEach(walk);
      };
      walk(line);
      return x === null ? null : Math.round(x);
    }),
  );

test("a bullet's marker starts at the same x as plain prose", async ({ page }) => {
  await page.keyboard.type("Non bulleted");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // out of the list-continuation path
  await page.keyboard.type("- bulleted");
  await page.keyboard.press("Meta+ArrowUp");

  const [prose, , bullet] = await glyphLefts(page);
  expect(bullet).toBe(prose);
});

test("wrapped rows still hang under the content column", async ({ page }) => {
  await page.keyboard.type(`- ${"word ".repeat(80)}`);
  await page.keyboard.press("Meta+ArrowUp");

  const rows = await page.evaluate(() => {
    const content = document.querySelector(".cm-content")!;
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(10);
    probe.style.cssText = "position:absolute;visibility:hidden";
    content.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 10;
    probe.remove();

    const r = new Range();
    r.selectNodeContents(content.querySelector(".cm-line")!);
    const lefts = [...r.getClientRects()].map((b) => Math.round(b.left));
    return { first: Math.min(...lefts), last: Math.max(...lefts), ch };
  });

  // The line wrapped, and its later rows sit exactly one marker (2ch) in.
  expect(rows.last - rows.first).toBe(Math.round(2 * rows.ch));
});
