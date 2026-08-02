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

    // One column's width, averaged over ten of them. Measured as a whole
    // hidden span: WebKit inflates the client rects of a range that starts or
    // ends part-way through a text node by about a pixel, so slicing glyphs
    // out of the line itself would measure ink the layout never used.
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(10);
    probe.style.cssText = "position:absolute;visibility:hidden";
    content.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 10;
    probe.remove();

    // The x each visual row of the line begins at. getClientRects yields one
    // rect per row per text run — highlighting splits the marker off from the
    // prose — so group by row and keep the leftmost, rather than taking the
    // extremes over every run.
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

  // The line wrapped, and every row after the first sits exactly one marker
  // ("- ", two columns) in.
  //
  // Compared as real numbers, to half a pixel. The two sides come from
  // different machinery — the hang is a `2ch` margin resolved against the
  // font, the rows' x's are glyph positions — and they agree to about a
  // thousandth of a pixel. Rounding each to an integer first threw that
  // agreement away: `round(x + 22.254) - round(x)` is 23, not 22, for a
  // quarter of the subpixel positions the line can land on, so the test
  // failed on where the editor happened to sit rather than on the rule.
  expect(rows.lefts.length).toBeGreaterThan(1);
  for (const left of rows.lefts.slice(1)) {
    expect(left - rows.lefts[0]!).toBeCloseTo(2 * rows.ch, 0);
  }
});
