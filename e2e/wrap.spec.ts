// Hanging indent (editor/wrap.ts). The column arithmetic is pure and covered
// by wrap.test.ts. Measuring where the decoration lands takes a layout
// engine: the decoration's `margin-left` composes with CodeMirror's base
// .cm-line padding instead of replacing it. An inline `padding-left` replaced
// that padding, so list lines drew their marker left of where prose starts.
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await page.keyboard.press("Meta+a");
});

// The x of each line's first non-whitespace glyph, in viewport pixels rounded
// to a whole one. A line with no such glyph reports null. Rounding is safe
// here because the test below compares two x's that should be identical, not
// two that differ by a subpixel gap.
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
  // A blank line between the paragraph and the bullet. glyphLefts reports
  // null for it, the hole in the destructure below.
  await page.keyboard.press("Enter");
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

    // One column's width, averaged over ten of them in a hidden span. WebKit
    // inflates the client rects of a range that starts or ends part-way
    // through a text node by about a pixel, so slicing glyphs out of the line
    // itself would measure a width the layout never used (testing.md §5).
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(10);
    probe.style.cssText = "position:absolute;visibility:hidden";
    content.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 10;
    probe.remove();

    // The leftmost x of each visual row of the line. getClientRects yields one
    // rect per row per text run, and highlighting splits the marker off from
    // the prose, so the loop groups the rects by row and keeps the leftmost
    // rather than reading the whole line's bounding box.
    const r = new Range();
    r.selectNodeContents(content.querySelector(".cm-line")!);
    const leftOf = new Map<number, number>();
    for (const box of r.getClientRects()) {
      const row = Math.round(box.top);
      leftOf.set(row, Math.min(leftOf.get(row) ?? Infinity, box.left));
    }
    const lefts = [...leftOf].sort(([a], [b]) => a - b).map(([, left]) => left);
    return { lefts, ch };
  });

  // The line wrapped, and every row after the first hangs exactly one marker
  // in: the two columns of "- ". The two sides come from different machinery.
  // The hang is a `2ch` margin resolved against the font. The rows' x's are
  // glyph positions. They agree to about a thousandth of a pixel, so the
  // assertion compares them without rounding, to half a pixel (testing.md §5).
  expect(rows.lefts.length).toBeGreaterThan(1);
  for (const left of rows.lefts.slice(1)) {
    expect(left - rows.lefts[0]!).toBeCloseTo(2 * rows.ch, 0);
  }
});
