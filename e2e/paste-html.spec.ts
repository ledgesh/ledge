// Rich-text paste (editor/htmlPaste.ts): a pasteboard carrying formatted HTML
// beside its plain text pastes as Markdown. Run in real WebKit because the
// parse is DOMParser's — the unit tests cover the conversion over hand-built
// trees (testing.md §2), and what only this layer can prove is that the real
// parser feeds it the same shape, that the chord reaches it, and that ⇧⌘V opts
// out.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await page.keyboard.press("Meta+a");
});

// Both flavors up, the way another application's copy leaves the pasteboard.
async function seed(page: import("@playwright/test").Page, text: string, html: string) {
  await page.evaluate(([t, h]) => window.__harness.setClipboard(t!, h!), [text, html]);
}

// The document as written, read back through the clipboard seam (the sanctioned
// window.__harness surface — formatting.spec.ts's move).
async function doc(page: import("@playwright/test").Page): Promise<string> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  return page.evaluate(() => window.__harness.clipboard());
}

test("a copied heading and bullet list paste as Markdown, not as bare lines", async ({ page }) => {
  await seed(
    page,
    "Webhooks\nis there a way to subscribe?\ndo you offer batching?",
    "<b>Webhooks</b><ul><li>is there a way to subscribe?</li><li>do you offer batching?</li></ul>",
  );
  await page.keyboard.press("Meta+v");
  await expect(page.locator(".cm-content")).toContainText("- is there a way to subscribe?");
  expect(await doc(page)).toBe(
    "**Webhooks**\n\n- is there a way to subscribe?\n- do you offer batching?",
  );
});

test("a copied link keeps its destination, which the plain text had thrown away", async ({ page }) => {
  await seed(page, "the docs", '<p>see <a href="https://ledge.dev/x">the docs</a></p>');
  await page.keyboard.press("Meta+v");
  expect(await doc(page)).toBe("see [the docs](https://ledge.dev/x)");
});

test("⇧⌘V pastes the pasteboard's own text, formatting and all left behind", async ({ page }) => {
  await seed(page, "the docs", '<p>see <a href="https://ledge.dev/x">the docs</a></p>');
  await page.keyboard.press("Meta+Shift+v");
  expect(await doc(page)).toBe("the docs");
});

test("a terminal-style copy pastes verbatim: colored spans are not formatting", async ({ page }) => {
  await seed(
    page,
    "$ ls -l\ntotal 0\nnotes.md",
    '<span style="color: rgb(50, 215, 75); font-family: monospace">$ ls -l</span>' +
      '<div><span style="color: rgb(255,255,255)">total 0</span></div>' +
      "<div><span>notes.md</span></div>",
  );
  await page.keyboard.press("Meta+v");
  expect(await doc(page)).toBe("$ ls -l\ntotal 0\nnotes.md");
});

test("a converted paste is one undo away from the note as it was", async ({ page }) => {
  await page.keyboard.type("before");
  await seed(page, "x", "<ul><li>x</li></ul>");
  await page.keyboard.press("Meta+v");
  expect(await doc(page)).toBe("before\n- x");
  await page.keyboard.press("Meta+z");
  expect(await doc(page)).toBe("before");
});

test("a paste inside a fenced block stays verbatim — the bytes there are the command", async ({
  page,
}) => {
  await page.keyboard.type("```sh\n");
  await seed(page, "echo hi", "<ul><li>echo hi</li></ul>");
  await page.keyboard.press("Meta+v");
  // The fence auto-closed on the third backtick (editor/fences.ts), so the
  // caret is on the body line between the pair.
  expect(await doc(page)).toBe("```sh\necho hi\n```");
});

test("a copied table arrives as a GFM table, and renders as one", async ({ page }) => {
  await seed(
    page,
    "a b\n1 2",
    "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
  await page.keyboard.press("Meta+v");
  expect(await doc(page)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
});

test("a copied code block arrives fenced, labelled with its language", async ({ page }) => {
  await seed(page, "const a = 1", '<pre><code class="language-ts">const a = 1</code></pre>');
  await page.keyboard.press("Meta+v");
  expect(await doc(page)).toBe("```ts\nconst a = 1\n```");
});
