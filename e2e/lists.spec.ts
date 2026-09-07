// List continuation (editor/lists.ts): Shift+Enter inside a list item opens a
// line indented under the item's text, and the next Enter keeps the list. On
// an ordered item that Enter used to delete the line just typed. The pure
// core covers the column arithmetic (lists.test.ts), so these specs cover
// what a user can see. Most read the document back through the clipboard,
// since live preview conceals markers and the DOM holds no markdown. The last
// test measures the rendering instead.
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
  // The blank line between them makes one loose list, since both use `-`.
  // Upstream would then prefix every item below it with a blank of its own.
  await page.keyboard.type("- [ ] Security questionnaire");
  await page.keyboard.press("Enter"); // opens "- [ ] "
  await page.keyboard.press("Enter"); // and leaves the list
  await page.keyboard.press("Enter"); // a blank line between the two lists
  await page.keyboard.type("- test");
  await page.keyboard.press("Enter");
  await page.keyboard.type("test");
  expect(await raw(page)).toBe("- [ ] Security questionnaire\n\n- test\n- test");
});

test("a fence typed inside a list item closes at the item's indent", async ({ page }) => {
  await page.keyboard.type("- item");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("```sh");
  expect(await raw(page)).toBe("- item\n  ```sh\n  ```");
});

test("a fence opener inside a list item is still the fence's Enter", async ({ page }) => {
  await page.keyboard.type("- item");
  await page.keyboard.press("Shift+Enter");
  // insertText rather than typing. Typing the third backtick already plants
  // the closer (editor/fences.ts), so a typed opener leaves Enter nothing to
  // close. A pasted one arrives unclosed. Inside a list item that Enter must
  // be the fence's, not the list's (the extension order in editor/setup.ts).
  await page.keyboard.insertText("```sh");
  await page.keyboard.press("Enter");
  expect(await raw(page)).toBe("- item\n  ```sh\n\n  ```");
});

// The continuation indent is 2 columns of text. Whether that lines up under
// live preview depends on how wide `- [ ]` renders: live preview hides the
// `- ` and draws `[ ]` as a checkbox 1ch wide (index.css .ledge-task, box
// plus margins). The space after `[ ]` is not concealed, so the label starts
// at column 2. This test measures the rendering, since only a real browser
// has those widths.
test("a task's label, a bullet's, and both continuations share one column", async ({ page }) => {
  await page.keyboard.type("- bullet");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("under");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] task");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("under");
  // ⌘↑ puts the caret at the document start. Nothing on that bullet line
  // conceals, so the measurement below sees every line rendered. A caret on
  // the task marker would reveal it as raw `- [ ]`, starting that line at
  // column 0 instead of 2.
  await page.keyboard.press("Meta+ArrowUp");

  // This measures the x of each line's first non-blank glyph, in character
  // widths past the first line's glyph. That one is the bullet's own dash, at
  // column 0. The origin stays fixed rather than following each line's own
  // box, because a list line's box is offset by its hanging indent
  // (editor/wrap.ts).
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

  // The bullet's own line starts at its dash, column 0. The other three start
  // at column 2: its continuation, the task's label past the rendered box, and
  // the task's continuation.
  expect(columns).toEqual([0, 2, 2, 2]);
});

test("Shift+Enter outside a list is still an ordinary newline", async ({ page }) => {
  await page.keyboard.type("hello");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("world");
  expect(await raw(page)).toBe("hello\nworld");
});
