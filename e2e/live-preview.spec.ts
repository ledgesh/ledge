// Live preview in the editor (editor/livePreview.ts): syntax conceals where
// the caret is not, a rendered link opens on a plain click (a revealed one
// needs ⌘), and copy yields raw markdown because the document never changes.
// Its neighbours are here too: the table widget (editor/tables.ts) and Enter
// out of a quote (editor/quotes.ts). livePreview.test.ts has the pure rules.
// Concealment is DOM behavior, so these run in real WebKit (testing.md §5).
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  // A fresh scratch note. The editor takes focus and the H1's placeholder
  // "Untitled" opens selected, so a test that types straight away replaces it
  // and writes into the title (e2e/new-note-caret.spec.ts).
  await page.keyboard.press("Meta+n");
});

test("syntax conceals when the caret leaves, reveals as it moves back in", async ({ page }) => {
  // A new note opens with the caret on the title, so move to the very top of
  // the document and type there instead.
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.type("## Hello **world** yes");
  await page.keyboard.press("Enter"); // caret leaves the heading line

  // Concealed: no ## and no **, just the styled text.
  const line = page.locator(".cm-line").first();
  await expect(line).toHaveText("Hello world yes");

  // Marks reveal when the selection touches the element that owns them. The
  // heading's element is the whole line, so the caret anywhere on it brings
  // the `##` back. The strong marks belong to `**world**`, which the caret at
  // the line start does not touch, so they stay concealed.
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

  // The rendered link gets a hotspot in the body-parented layer. That layer
  // supplies the hand cursor: WKWebView does not honour in-editor `cursor`
  // reliably (index.css, .ledge-mdlink-live).
  await expect(page.locator(".ledge-hotspot")).toHaveCount(1);

  // A plain click on the rendered link opens it through the bridge (a native
  // seam, so the harness records the call). The click lands on the hotspot
  // sitting over the link, and does not move the caret into the link, so the
  // link stays concealed.
  const link = page.locator(".ledge-mdlink");
  const hotspot = page.locator(".ledge-hotspot");
  await hotspot.click();
  await expect
    .poll(() => page.evaluate(() => window.__harness.linkOpens()))
    .toEqual(["https://example.com/docs"]);
  await expect(line).toHaveText("see Ledge docs ok");

  // Arrow the caret onto the link: it reveals, and a plain click on the line
  // moves the caret and does not open the link.
  await page.keyboard.press("ArrowUp");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowRight");
  await expect(line).toContainText("](https://example.com/docs)");
  // Revealed raw text gets no hotspot, so the hand cursor is gone and a plain
  // click no longer opens. ⌘-click on it still does, through the in-editor
  // handler (livePreview.ts clickToOpen).
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

  // The in-editor `cursor: pointer` rules for a rendered link and a task
  // checkbox (index.css). WKWebView ignores them inside the editor, so the
  // hand a user sees comes from the hotspot layer, which covers rendered
  // links, wikilinks, tags and checkboxes: two hotspots here.
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

  // The caret in the block reveals both fences.
  await page.locator(".cm-line", { hasText: 'echo "ready"' }).click();
  await expect(page.locator(".cm-line.ledge-code-top")).toHaveText("```sh");
  await expect(page.locator(".cm-line.ledge-code-bottom")).toHaveText("```");

  // The block chrome (blocks.ts overlay) still finds its anchors. Its control
  // group carries `caret` while the caret is in the block, and
  // `.ledge-ctl-group.caret` sets opacity to 1 (index.css).
  await expect(page.locator(".ledge-ctl-group.caret")).toHaveCount(1);
});

test("a task renders a checkbox; clicking it toggles the [x] in the text", async ({ page }) => {
  // ⌘A selects the whole scratch seed, so the typing replaces it. Typing at
  // the fresh caret instead would land in the selected placeholder title and
  // give the line "# - [ ] buy milk", a heading with no checkbox in it.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("- [ ] buy milk");

  // The caret is in the label, not on the marker, so the marker stays
  // concealed. The checkbox is real and unchecked, the raw [ ] is gone, and
  // so is the `- ` bullet: the widget stands in for both.
  const box = page.locator("input.ledge-task");
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await expect(page.locator(".cm-line").first()).not.toContainText("[ ]");
  await expect(page.locator(".cm-line").first()).toHaveText(" buy milk");

  // Clicking it checks the box by editing the document: the text now carries
  // [x], the widget re-renders checked, and the label gets the done styling.
  await box.dispatchEvent("mousedown", { button: 0 });
  await expect(page.locator("input.ledge-task")).toBeChecked();
  await expect(page.locator(".ledge-task-done")).toHaveText(" buy milk");

  // Caret onto the marker's edge reveals the raw [x].
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".cm-line").first()).toContainText("[x]");
});

// The regression: a few characters selected on a task line drew as the whole
// line, about half the time. CodeMirror paints the selection (drawSelection),
// and to place each end of a range it asks posAtCoords for the position at
// the far left of that end's row. On a line that starts with a replaced range
// (a task's hidden `- ` plus its checkbox widget, and equally a heading's
// `## `) that answer came back at random as either the line start or the far
// side of the widget, so the two ends of one selection disagreed about which
// visual row they were on. drawSelection then drew the between-rows shape:
// from the first end to the right margin, and from the left margin to the
// second. The randomness was upstream, a tie-break in the tile scan, fixed in
// @codemirror/view 6.43.8; package.json pins ^6.43.9. Only a real layout can
// be asked where a selection was drawn, so this test is here rather than in a
// unit file (testing.md §2).
test("a few characters selected on a task line draw a few characters wide", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("- [x] other test");

  const lineWidth = (await page.locator(".cm-line").first().boundingBox())!.width;
  const drawnWidth = () =>
    page
      .locator(".cm-selectionBackground")
      .evaluateAll((els) => els.reduce((w, el) => w + el.getBoundingClientRect().width, 0));

  // Six presses. The old failure was a coin flip per measure: one press would
  // pass half the time, and six presses catch it 63 times in 64.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(drawnWidth).toBeLessThan(lineWidth / 4);
  }
});

test("Enter on an empty quote line exits the quote in one press", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("> 432");
  await page.keyboard.press("Enter"); // upstream continues the quote: "> "
  await page.keyboard.press("Enter"); // quotes.ts: clears the marker line

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

  // A click on a cell moves the caret to that cell's text, which reveals the
  // raw table. Typing lands where the click aimed.
  await table.locator("td", { hasText: "2" }).click();
  await expect(page.locator(".ledge-mdtable")).toHaveCount(0);
  await expect(page.locator(".cm-line").nth(1)).toHaveText("| --- | --- |");
  await page.keyboard.type("!");
  await expect(page.locator(".cm-line").nth(2)).toHaveText("| 1 | !2 |");
});

test("clicking a cell still lands there after edits above shift the table down", async ({ page }) => {
  // A table bakes absolute cell offsets into its DOM, so a shifted table has
  // to be redrawn rather than reused: TableWidget.eq compares position as
  // well as source (editor/tables.ts). e2e/images.spec.ts covers the same
  // shift for a rendered image, which reads its position from the DOM
  // instead.
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
  // ⌘A selects the whole seed: the "# Untitled" title and the two empty lines
  // under it. The typing replaces all of it.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("run `bun test` now");
  await page.keyboard.press("Enter");

  const line = page.locator(".cm-line").first();
  await expect(line).toHaveText("run bun test now");
  const chip = page.locator(".ledge-inline-code");
  await expect(chip).toHaveText("bun test");
  // The chip needs a visible background; the default is transparent.
  await expect
    .poll(() => chip.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe("rgba(0, 0, 0, 0)");

  // Revealed, the chip stays on the text and the backticks stay markers.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveText("run `bun test` now");
  await expect(chip).toHaveText("bun test");

  // A fenced block shares the parser's tag with inline code upstream. It must
  // not share the chip: it has the code-block card instead.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("```\nfenced text\n");
  await expect(page.locator(".cm-line.ledge-code")).not.toHaveCount(0);
  await expect(page.locator(".ledge-inline-code")).toHaveCount(0);
});
