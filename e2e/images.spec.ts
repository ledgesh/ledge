// Rendered images (editor/images.ts): an image reference alone on its line
// draws as a real <img> while the caret is elsewhere, reveals to raw markdown
// when the caret arrives (or the image is clicked), and a ⌘V with an image on
// the pasteboard embeds a reference. Run in real WebKit for the same reason
// as live-preview.spec.ts: widget swap-in/out is DOM behavior a unit test
// cannot see. The harness serves assets from an in-memory map (a real 1×1
// PNG, so the <img> genuinely loads) and fakes assetPaste the same way.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
});

test("an asset image renders when the caret leaves its line, reveals when it returns", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("above\n![a dot](assets/dot.png)");

  // Caret still on the line: raw markdown, no widget.
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);

  await page.keyboard.press("Enter");
  const img = page.locator(".ledge-mdimage img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(img).toHaveAttribute("alt", "a dot");
  // The raw markdown is gone from the text layer while the widget stands in.
  await expect(page.locator(".cm-content")).not.toContainText("assets/dot.png");

  // Caret back into the line (ArrowLeft from the line below steps onto its
  // end; vertical motion hops over a block widget, which is why the click is
  // the primary reveal — the spec below): the widget yields to the markdown.
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("![a dot](assets/dot.png)");
});

test("clicking a rendered image reveals its markdown right there", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("![pic](assets/dot.png)");
  await page.keyboard.press("Enter");
  const widget = page.locator(".ledge-mdimage");
  await expect(widget).toBeVisible();

  await widget.click();
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("![pic](assets/dot.png)");
});

test("a missing asset says so in place instead of rendering nothing", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("![gone](assets/nope.png)");
  await page.keyboard.press("Enter");
  const broken = page.locator(".ledge-mdimage-broken");
  await expect(broken).toBeVisible();
  await expect(broken).toContainText("assets/nope.png");
});

test("an image inline in prose stays text — only alone-on-a-line renders", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("see ![x](assets/dot.png) here");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
});

test("⌘V with an image (and no text) on the pasteboard embeds it, rendered at once", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("notes so far");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Meta+v");

  // The caret parks below the inserted line, so the paste shows the IMAGE
  // immediately — no raw markdown to arrow away from.
  await expect(page.locator(".ledge-mdimage img")).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText("assets/pasted-1.png");

  // The document really carries the reference: stepping the caret back onto
  // the line reveals it.
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".cm-content")).toContainText("![](assets/pasted-1.png)");
});

test("⌘V with text on the pasteboard still pastes the text", async ({ page }) => {
  // Seed the harness clipboard through the app's own copy path.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("plain words");
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Meta+v");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
  const lines = page.locator(".cm-line");
  await expect(lines.nth(0)).toHaveText("plain words");
  await expect(lines.nth(1)).toHaveText("plain words");
});
