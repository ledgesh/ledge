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

test("clicking a rendered image still reveals it after edits above shift it down", async ({ page }) => {
  // The widget keeps its DOM (and its listener) across edits elsewhere in the
  // document — deliberately, since rebuilding it re-runs the asset fetch. So
  // the click must read the image's position off the DOM rather than
  // remember the one it was built with, or clicking the picture silently
  // moves the caret to whatever now sits at the old offset.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("x\n![pic](assets/dot.png)\nbelow");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(1);

  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.type("hello world ");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(1);

  await page.locator(".ledge-mdimage").click();
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("![pic](assets/dot.png)");
  // The caret really landed on the image's line: typing edits it, not line 1.
  await page.keyboard.type("Z");
  await expect(page.locator(".cm-line").nth(1)).toHaveText("Z![pic](assets/dot.png)");
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
  await expect(page.locator(".cm-content")).not.toContainText(".ledge-assets/pasted-1.png");

  // The document really carries the reference: stepping the caret back onto
  // the line reveals it.
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".cm-content")).toContainText("![](.ledge-assets/pasted-1.png)");
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

test("dragging a selection across an image keeps the image drawn", async ({ page }) => {
  // The regression: an image revealing mid-drag collapses its line to one row
  // of markdown, which yanks every line below it up past the held pointer,
  // which moves the selection head off the image, which redraws it — the
  // image flaps and a selection spanning it can never settle. The anchor rule
  // (livePreview.ts blockRevealed) fixes each block's face for the whole drag.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("above the picture\n![pic](assets/dot.png)\nbelow the picture");
  const widget = page.locator(".ledge-mdimage");
  await expect(widget).toHaveCount(1);

  const below = await page.locator(".cm-line", { hasText: "below the picture" }).boundingBox();
  const above = await page.locator(".cm-line", { hasText: "above the picture" }).boundingBox();
  if (!below || !above) throw new Error("lines not laid out");

  await page.mouse.move(below.x + below.width - 2, below.y + below.height / 2);
  await page.mouse.down();
  const startY = below.y + below.height / 2;
  const endY = above.y + above.height / 2;
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(above.x + 2, startY + ((endY - startY) * step) / 12);
    // The whole point: never once does the widget blink out mid-sweep.
    await expect(widget).toHaveCount(1);
  }
  await page.mouse.up();
  await expect(widget).toHaveCount(1);
  // Drawn, but visibly inside the selection: the image paints over
  // CodeMirror's selection layer, so it wears the tint itself.
  await expect(page.locator(".ledge-mdimage.is-selected")).toHaveCount(1);

  // And the selection it built is real — spanning the image, so typing over
  // it takes the image with it.
  await page.keyboard.type("X");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
  await expect(page.locator(".cm-content")).not.toContainText("assets/dot.png");
});

test("shift-arrowing a selection over an image keeps it drawn, and onto it reveals it", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("above the picture\n![pic](assets/dot.png)\nbelow the picture");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(1);

  // Extending upward from below: the anchor stays off the image, so it draws.
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(1);
  await expect(page.locator(".ledge-mdimage.is-selected")).toHaveCount(1);
  // The <img> survived the tint: repainting the selected face must not
  // rebuild the element and re-fetch the bytes.
  await expect(page.locator(".ledge-mdimage img")).toHaveAttribute("src", /^data:image\/png;base64,/);

  // A plain caret landing on the line still reveals the markdown, unchanged.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("![pic](assets/dot.png)");
});
