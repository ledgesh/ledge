// Rendered images (editor/images.ts), in real WebKit because a unit test
// cannot see the widget swap in and out (testing.md §5, like
// live-preview.spec.ts). The harness serves assets from an in-memory map
// holding a real 1×1 PNG, so the <img> loads. Its pasteImage fake ignores the
// pasteboard and always returns a fresh reference, so the ⌘V spec below never
// puts a picture on the harness clipboard.
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

  // ArrowLeft from the line below steps onto the end of the image's line, and
  // the markdown replaces the widget. Vertical motion hops over a block widget
  // instead, so a click is the other way onto the line. The next spec covers
  // it.
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
  // ImageWidget.eq compares source, alt and selected face, not position
  // (images.ts), so CodeMirror keeps this element and its mousedown listener
  // when an edit above shifts the image down. The click reads the position off
  // the DOM (posAtDOM), not the offset the widget was built with. That offset
  // would name some other line by now.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("x\n![pic](assets/dot.png)\nbelow");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(1);

  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.type("hello world ");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(1);

  await page.locator(".ledge-mdimage").click();
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("![pic](assets/dot.png)");
  // The caret really landed on the image's line: typing edits that line, not
  // the one above it.
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

  // The caret lands below the inserted line, so the paste shows the image at
  // once, with no raw markdown to move the caret off first.
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

// The platform's paste event, which is how a phone's callout Paste arrives
// (editor/clipboard.ts pasteEvent). Built by hand the way Photos' Copy leaves
// it on iOS: a picture file and no text. The harness's pasteImage fake then
// supplies the reference, as it does for ⌘V.
test("a paste event carrying a picture and no text embeds it, rendered at once", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("notes so far");
  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0xff, 0xd8, 0xff])], "image.jpeg", { type: "image/jpeg" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    document.querySelector(".cm-content")!.dispatchEvent(event);
  });

  await expect(page.locator(".ledge-mdimage img")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".cm-content")).toContainText("![](.ledge-assets/pasted-1.png)");
  await expect(page.locator(".cm-line").nth(0)).toHaveText("notes so far");
  // The picture is the event's own bytes, not a second read of the pasteboard.
  expect(await page.evaluate(() => window.__harness.pastedBytes())).toBe("/9j/");
});

test("dragging a selection across an image keeps the image drawn", async ({ page }) => {
  // The regression this covers: an image that reveals mid-drag collapses its
  // line to one row of markdown, and the lines below jump up past the held
  // pointer. The block then flips between its two faces for the rest of the
  // drag. blockRevealed (livePreview.ts) reads the selection's anchor, which
  // does not move mid-drag, so each block keeps one face for the whole drag.
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
    // The widget must not blink out at any point in the sweep.
    await expect(widget).toHaveCount(1);
  }
  await page.mouse.up();
  await expect(widget).toHaveCount(1);
  // The image stays drawn, and shows that it sits inside the selection. An
  // opaque image covers CodeMirror's selection layer, so the widget takes a
  // selected face of its own.
  await expect(page.locator(".ledge-mdimage.is-selected")).toHaveCount(1);

  // The selection the drag built is real and spans the image: typing over it
  // deletes the image too.
  await page.keyboard.type("X");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
  await expect(page.locator(".cm-content")).not.toContainText("assets/dot.png");
});

test("shift-arrowing a selection over an image keeps it drawn, and onto it reveals it", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("above the picture\n![pic](assets/dot.png)\nbelow the picture");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(1);

  // Shift-arrowing up from the line below leaves the anchor off the image, so
  // it stays drawn.
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(1);
  await expect(page.locator(".ledge-mdimage.is-selected")).toHaveCount(1);
  // The <img> still holds its bytes: updateDOM repaints the selected face in
  // place (images.ts). A rebuild would hand the widget a new <img> whose src
  // is set only once the asset promise resolves, blanking the frame for a
  // tick.
  await expect(page.locator(".ledge-mdimage img")).toHaveAttribute("src", /^data:image\/png;base64,/);

  // A plain caret still reveals the markdown. It puts anchor and head on the
  // image's line, and blockRevealed reveals a block its selection starts on.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("![pic](assets/dot.png)");
});
