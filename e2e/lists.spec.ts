// List continuation (editor/lists.ts): Shift+Enter inside a list item opens a
// line indented under the item's TEXT, and the next Enter keeps the list —
// the ordered-item case used to delete the typed line outright. The column
// arithmetic lives in the pure core (lists.test.ts); these are the
// user-observable halves, read back through the clipboard seam because
// indentation has no visible raw form under live preview.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await page.keyboard.press("Meta+a");
});

// The document as written: select all, copy through the harness clipboard.
async function raw(page: import("@playwright/test").Page): Promise<string> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  const text = await page.evaluate(() => window.__harness.clipboard());
  await page.keyboard.press("ArrowRight"); // collapse to the end, ready to type on
  return text;
}

test("Shift+Enter in a bullet indents under the text", async ({ page }) => {
  await page.keyboard.type("- foo");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("bar");
  expect(await raw(page)).toBe("- foo\n  bar");
});

test("a checkbox item indents to its bullet, not past the box", async ({ page }) => {
  await page.keyboard.type("- [ ] task");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("why");
  expect(await raw(page)).toBe("- [ ] task\n  why");
});

test("a checkbox item's text survives the next Enter", async ({ page }) => {
  await page.keyboard.type("- [ ] task");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("why");
  await page.keyboard.press("Enter");
  expect(await raw(page)).toBe("- [ ] task\n  why\n  ");
});

test("Enter on a checkbox item's own line still opens the next checkbox", async ({ page }) => {
  await page.keyboard.type("- [ ] task");
  await page.keyboard.press("Enter");
  await page.keyboard.type("next");
  expect(await raw(page)).toBe("- [ ] task\n- [ ] next");
});

test("the continuation survives the next Enter on an ordered item", async ({ page }) => {
  await page.keyboard.type("1. foo");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("bar");
  await page.keyboard.press("Enter");
  expect(await raw(page)).toBe("1. foo\n   bar\n   ");
});

test("Enter on an abandoned continuation clears it, leaving no stray indent", async ({ page }) => {
  await page.keyboard.type("- foo");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Enter");
  expect(await raw(page)).toBe("- foo\n");
});

test("Enter on the empty marker leaves the list, with no blank line behind", async ({ page }) => {
  await page.keyboard.type("- Line 1");
  await page.keyboard.press("Enter"); // opens "- "
  await page.keyboard.press("Enter"); // and leaves the list
  await page.keyboard.type("Line 2");
  expect(await raw(page)).toBe("- Line 1\nLine 2");
});

test("a list started under an earlier one does not inherit double spacing", async ({ page }) => {
  // The blank line that separates them makes ONE loose list, since both use
  // `-`; upstream would prefix every item below it with a blank of its own.
  await page.keyboard.type("- [ ] Security questionnaire");
  await page.keyboard.press("Enter"); // opens "- [ ] "
  await page.keyboard.press("Enter"); // and leaves the list
  await page.keyboard.press("Enter"); // a blank line between the two lists
  await page.keyboard.type("- test");
  await page.keyboard.press("Enter");
  await page.keyboard.type("test");
  expect(await raw(page)).toBe("- [ ] Security questionnaire\n\n- test\n- test");
});

test("a fence opener inside a list item is still the fence's Enter", async ({ page }) => {
  await page.keyboard.type("- item");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("```sh");
  await page.keyboard.press("Enter");
  expect(await raw(page)).toBe("- item\n  ```sh\n\n  ```");
});

// The continuation indent is 2 columns of TEXT; whether it LOOKS right under
// live preview is the checkbox widget's advance (index.css .ledge-task, pinned
// to 1ch so `- [ ]` renders exactly as wide as the `- ` it stands in for).
// Only real WebKit can answer that, and only by measuring.
test("a task's label, a bullet's, and both continuations share one column", async ({ page }) => {
  await page.keyboard.type("- bullet");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("under");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] task");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("under");
  await page.keyboard.press("Meta+ArrowUp"); // caret off the lines: nothing revealed

  // The x of each line's first non-blank glyph, in character widths past the
  // FIRST line's — the bullet's own dash, which is column 0 by construction.
  // Measured against a fixed origin rather than each line's own box: a list
  // line's box is offset by its hanging indent (editor/wrap.ts).
  const columns = await page.evaluate(() => {
    const content = document.querySelector(".cm-content")!;
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(10);
    probe.style.cssText = "position:absolute;visibility:hidden";
    content.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 10;
    probe.remove();
    let origin: number | null = null;
    return [...content.querySelectorAll(".cm-line")].map((line) => {
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
      if (x === null) return null;
      if (origin === null) origin = x;
      return Math.round((x - origin) / ch);
    });
  });

  // The bullet's own line starts at its dash (column 0); every other line —
  // its continuation, the task's LABEL past the rendered box, and the task's
  // continuation — starts at column 2.
  expect(columns).toEqual([0, 2, 2, 2]);
});

test("Shift+Enter outside a list is still an ordinary newline", async ({ page }) => {
  await page.keyboard.type("hello");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("world");
  expect(await raw(page)).toBe("hello\nworld");
});
