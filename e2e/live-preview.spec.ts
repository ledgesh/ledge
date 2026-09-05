// Live preview in the editor (editor/livePreview.ts): markdown syntax
// conceals where the caret is not, reveals where it is, links follow on
// ⌘-click, and none of it changes the document — copy still yields raw
// markdown. These are the user-observable halves of the pure core's rules
// (livePreview.test.ts), run in real WebKit because concealment is exactly
// the kind of DOM behavior a unit test cannot see.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
});

test("syntax conceals when the caret leaves, reveals as it moves back in", async ({ page }) => {
  await page.keyboard.press("Meta+ArrowUp"); // the caret opens IN the title; this note is typed from the top
  await page.keyboard.type("## Hello **world** yes");
  await page.keyboard.press("Enter"); // caret leaves the heading line

  // Concealed: no ## and no ** — just the text, styled.
  const line = page.locator(".cm-line").first();
  await expect(line).toHaveText("Hello world yes");

  // Caret onto the line reveals the heading marks (the line is the heading's
  // element), but not the strong marks — their element is the word.
  await page.keyboard.press("ArrowUp");
  await expect(line).toHaveText("## Hello world yes");

  // Walking the caret to the strong element's edge reveals it too.
  await page.keyboard.press("End");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveText("## Hello **world** yes");
});

test("a rendered link opens on plain click; a revealed one is caret territory", async ({ page }) => {
  await page.keyboard.type("see [Ledge docs](https://example.com/docs) ok");
  await page.keyboard.press("Enter");

  const line = page.locator(".cm-line").first();
  await expect(line).toHaveText("see Ledge docs ok");

  // The rendered link gets a cursor hotspot in the body-parented layer — the
  // WKWebView-proof hand (in-editor `cursor` is unreliable there).
  await expect(page.locator(".ledge-hotspot")).toHaveCount(1);

  // Plain click on the RENDERED link opens it through the bridge (recorded
  // by the harness — launching a browser is a native seam) and does NOT move
  // the caret into it: the link stays concealed. The hotspot IS the click
  // surface — it sits over the link and owns the gesture.
  const link = page.locator(".ledge-mdlink");
  const hotspot = page.locator(".ledge-hotspot");
  await hotspot.click();
  await expect
    .poll(() => page.evaluate(() => window.__harness.linkOpens()))
    .toEqual(["https://example.com/docs"]);
  await expect(line).toHaveText("see Ledge docs ok");

  // Arrow the caret onto the link: it reveals, and a plain click on the line
  // is a caret move that opens nothing.
  await page.keyboard.press("ArrowUp");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowRight");
  await expect(line).toContainText("](https://example.com/docs)");
  // Revealed raw text has no hotspot — the hand (and the click-to-open)
  // withdraw together.
  await expect(page.locator(".ledge-hotspot")).toHaveCount(0);
  await line.click();
  expect(await page.evaluate(() => window.__harness.linkOpens())).toHaveLength(1);

  // Caret away re-conceals; ⌘-click keeps working on the rendered link.
  await page.keyboard.press("Meta+ArrowDown");
  await expect(line).toHaveText("see Ledge docs ok");
  await hotspot.click({ modifiers: ["Meta"] });
  await expect
    .poll(() => page.evaluate(() => window.__harness.linkOpens()))
    .toHaveLength(2);

  // The cursor follows the gesture: a rendered link asks for the hand (it
  // acts on click), and so does a checkbox — each also gets its hotspot.
  await expect(link).toHaveCSS("cursor", "pointer");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] task");
  await expect(page.locator("input.ledge-task")).toHaveCSS("cursor", "pointer");
  await expect(page.locator(".ledge-hotspot")).toHaveCount(2);
});

test("fence marks conceal outside the block; the language and code stay", async ({ page }) => {
  // Give the scratch note a ```sh block, then put the caret back at the top of
  // the note, outside it: the fences hide, the info string is the caption.
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText('# Untitled\n\n```sh\necho "ready"\n```\n');
  await page.keyboard.press("Meta+ArrowUp");
  await expect(page.locator(".cm-line.ledge-code-top")).toHaveText("sh");
  await expect(page.locator(".cm-line.ledge-code-bottom")).toHaveText("");
  await expect(page.locator(".cm-line", { hasText: 'echo "ready"' })).toBeVisible();

  // Caret into the block reveals both fences...
  await page.locator(".cm-line", { hasText: 'echo "ready"' }).click();
  await expect(page.locator(".cm-line.ledge-code-top")).toHaveText("```sh");
  await expect(page.locator(".cm-line.ledge-code-bottom")).toHaveText("```");

  // ...and the block chrome (blocks.ts overlay) still finds its anchors: the
  // caret-in-block state is exactly what lights the control group.
  await expect(page.locator(".ledge-ctl-group.caret")).toHaveCount(1);
});

test("a task renders a checkbox; clicking it toggles the [x] in the text", async ({ page }) => {
  // Replace the scratch seed wholesale: typed-at-caret content would merge
  // into its "# Untitled" line and the task's label would swallow it.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("- [ ] buy milk");

  // The caret sits in the label, which must NOT reveal the marker: it is a
  // real checkbox, unchecked, and the raw [ ] is gone — and so is the `- `
  // bullet, because the checkbox IS the bullet.
  const box = page.locator("input.ledge-task");
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await expect(page.locator(".cm-line").first()).not.toContainText("[ ]");
  await expect(page.locator(".cm-line").first()).toHaveText(" buy milk");

  // Clicking it checks the box by editing the DOCUMENT: the text now carries
  // [x], the widget re-renders checked, and the label styles done.
  await box.dispatchEvent("mousedown", { button: 0 });
  await expect(page.locator("input.ledge-task")).toBeChecked();
  await expect(page.locator(".ledge-task-done")).toHaveText(" buy milk");

  // Caret onto the marker's edge reveals the raw [x].
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".cm-line").first()).toContainText("[x]");
});

// A few characters selected on a task line draw as a few characters, not as
// the whole line. The selection is PAINTED by CodeMirror (drawSelection), and
// to place each end of a range it asks posAtCoords for the position at the far
// left of that end's row. On a line whose first thing is a replaced range —
// a task's hidden `- ` and its checkbox widget, and equally a heading's `## `
// — that question came back at random as either the line start or the far
// side of the widget, so the two ends of one selection disagreed about which
// visual row they were on. drawSelection then drew the between-rows shape:
// from the first end to the right margin, and from the left margin to the
// second. Two characters, painted as the entire line, about half the time.
//
// The randomness was upstream (a tie-break in the tile scan) and is fixed in
// @codemirror/view 6.43.8, which is the floor package.json now pins. This test
// is here rather than in a unit file because only a real layout can be asked
// where a selection was drawn.
test("a few characters selected on a task line draw a few characters wide", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("- [x] other test");

  const lineWidth = (await page.locator(".cm-line").first().boundingBox())!.width;
  const drawnWidth = () =>
    page
      .locator(".cm-selectionBackground")
      .evaluateAll((els) => els.reduce((w, el) => w + el.getBoundingClientRect().width, 0));

  // Six presses: the old failure was a coin flip per measure, so one press
  // would have passed half the time and six catch it 63 times in 64.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(drawnWidth).toBeLessThan(lineWidth / 4);
  }
});

test("Enter on an empty quote line exits the quote in one press", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("> 432");
  await page.keyboard.press("Enter"); // upstream continues the quote: "> "
  await page.keyboard.press("Enter"); // ours: exit — clear the marker line

  const lines = page.locator(".cm-line");
  // Caret sits on the emptied line 2: no stray ">", no mismatched markers.
  await expect(lines.nth(1)).toHaveText("");
  await page.keyboard.type("free");
  await expect(lines.nth(1)).toHaveText("free");
  // The quote above is untouched (quote marks do not conceal).
  await expect(lines.nth(0)).toHaveText("> 432");
});

test("a pipe table renders as a real table; clicking a cell reveals the pipes there", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("| a | b |\n| --- | --- |\n| 1 | 2 |\n");

  // Caret on the line after the table: the pipes are a rendered table.
  const table = page.locator(".ledge-mdtable");
  await expect(table).toBeVisible();
  await expect(table.locator("th")).toHaveText(["a", "b"]);
  await expect(table.locator("td")).toHaveText(["1", "2"]);
  await expect(page.locator(".cm-line", { hasText: "---" })).toHaveCount(0);

  // A click on a cell is a caret move to that cell's text, which reveals the
  // raw table — typing lands exactly where the click aimed.
  await table.locator("td", { hasText: "2" }).click();
  await expect(page.locator(".ledge-mdtable")).toHaveCount(0);
  await expect(page.locator(".cm-line").nth(1)).toHaveText("| --- | --- |");
  await page.keyboard.type("!");
  await expect(page.locator(".cm-line").nth(2)).toHaveText("| 1 | !2 |");
});

test("clicking a cell still lands there after edits above shift the table down", async ({ page }) => {
  // The counterpart to the image case (e2e/images.spec.ts): a table bakes
  // absolute cell offsets into its DOM, so a shifted table has to be redrawn
  // rather than reused — TableWidget.eq compares position for exactly this.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("x\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  await expect(page.locator(".ledge-mdtable")).toBeVisible();

  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.type("hello world ");
  await expect(page.locator(".ledge-mdtable")).toBeVisible();

  await page.locator(".ledge-mdtable td", { hasText: "2" }).click();
  await expect(page.locator(".ledge-mdtable")).toHaveCount(0);
  await page.keyboard.type("!");
  await expect(page.locator(".cm-line").nth(3)).toHaveText("| 1 | !2 |");
});

test("a --- line draws as a rule; the caret on it reveals the dashes", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("above\n\n---\n\nbelow");
  await expect(page.locator(".ledge-hrule")).toHaveCount(1);

  // Walk the caret up onto the rule's line: the raw dashes come back.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".ledge-hrule")).toHaveCount(0);
  await expect(page.locator(".cm-line", { hasText: "---" })).toBeVisible();
});

test("copy yields raw markdown — concealment never touches the document", async ({ page }) => {
  await page.keyboard.type("**bold** stays markdown");
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  await expect
    .poll(() => page.evaluate(() => window.__harness.clipboard()))
    .toContain("**bold** stays markdown");
});

test("inline code keeps a chip of its own once the backticks conceal", async ({ page }) => {
  // The whole editor is monospace and live preview takes the backticks away,
  // so the chip (editor/setup.ts's inlineCodeTag -> .ledge-inline-code) is the
  // only thing separating code from the prose it sits in.
  await page.keyboard.press("Meta+a"); // over the title a new note opens with
  await page.keyboard.type("run `bun test` now");
  await page.keyboard.press("Enter");

  const line = page.locator(".cm-line").first();
  await expect(line).toHaveText("run bun test now");
  const chip = page.locator(".ledge-inline-code");
  await expect(chip).toHaveText("bun test");
  // A visible background is the point; the default is transparent.
  await expect
    .poll(() => chip.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe("rgba(0, 0, 0, 0)");

  // Revealed, the chip stays on the text and the backticks stay markers.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveText("run `bun test` now");
  await expect(chip).toHaveText("bun test");

  // A fenced block shares the parser's tag with inline code upstream; it must
  // not share the chip — it has the code-block card instead.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("```\nfenced text\n");
  await expect(page.locator(".cm-line.ledge-code")).not.toHaveCount(0);
  await expect(page.locator(".ledge-inline-code")).toHaveCount(0);
});
