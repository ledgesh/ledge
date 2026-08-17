// The note editor's context menu (interactions.md §11), driven end to end in
// headless WebKit.
//
// The unit tests own which verbs a click calls for (commands/editorMenu.
// test.ts); everything here is the half they cannot see — that the gesture
// arrives at all (the window listener, and the hotspots over rendered links
// that would otherwise eat it), that the caret lands where the pointer did,
// and that an item picked from the menu does the same thing its chord does.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const menu = (page: Page) => page.getByRole("menu");
// The invisible hotspots the link layer floats over a rendered checkbox and a
// rendered wikilink (editor/livePreview.ts), by the tooltip each carries.
const taskHotspot = (page: Page) => page.locator(".ledge-hotspot[title='Toggle Checkbox']");
const wikiHotspot = (page: Page) => page.locator(".ledge-hotspot[title='Click to open note']");

// Every item the open menu carries, in order — the label alone, without the
// key chip beside it (the label is the first child of the row's button).
const labels = (page: Page): Promise<string[]> =>
  menu(page)
    .getByRole("menuitem")
    .evaluateAll((els) => els.map((el) => (el.firstElementChild?.textContent ?? "").trim()));

// Pick one by its label. By index rather than by accessible name because the
// name carries the chip too, and "Paste" is a prefix of "Paste as Plain Text".
async function pick(page: Page, label: string): Promise<void> {
  const i = (await labels(page)).indexOf(label);
  expect(i, `no "${label}" in the menu`).toBeGreaterThanOrEqual(0);
  await menu(page).getByRole("menuitem").nth(i).click();
  await expect(menu(page)).toHaveCount(0);
}

// Replace the note with `body`, written whole so fences and brackets land
// exactly as spelled (autoclose and the `[[` picker would answer typing).
async function write(page: Page, body: string): Promise<void> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(body);
}

// The document as written, read back through the clipboard seam — the
// sanctioned way to see raw markers under live preview (formatting.spec.ts).
async function raw(page: Page): Promise<string> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  const text = await page.evaluate(() => window.__harness.clipboard());
  await page.keyboard.press("ArrowRight"); // collapse to the end
  return text;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
});

test("right-clicking a note opens a menu: the clipboard, then the writing verbs", async ({ page }) => {
  await write(page, "hello world");
  await page.locator(".cm-line").first().click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  expect(await labels(page)).toEqual([
    "Cut",
    "Copy",
    "Paste",
    "Paste as Plain Text",
    "Select All",
    "Bold",
    "Italic",
    "Insert Link",
    "Link to Note",
    "Code Block",
    "Insert Image…",
  ]);
  // A menu is a modal layer like any other: Escape closes it and nothing else.
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  expect(await raw(page)).toBe("hello world");
});

test("a menu item does what its chord does: Copy round-trips, Bold wraps", async ({ page }) => {
  await write(page, "hello world");
  await page.keyboard.press("Meta+a");
  await page.locator(".cm-line").first().click({ button: "right" });
  await pick(page, "Copy");
  expect(await page.evaluate(() => window.__harness.clipboard())).toBe("hello world");

  await page.keyboard.press("Meta+a");
  await page.locator(".cm-line").first().click({ button: "right" });
  await pick(page, "Bold");
  expect(await raw(page)).toBe("**hello world**");
});

test("Paste lands at the caret the right-click placed", async ({ page }) => {
  await page.evaluate(() => window.__harness.setClipboard("PASTED", ""));
  await write(page, "one\ntwo\nthree");
  // Right-click line two: the caret must move there, not stay at the end.
  await page.locator(".cm-line", { hasText: "two" }).click({ button: "right" });
  await pick(page, "Paste");
  expect(await raw(page)).toBe("one\ntwoPASTED\nthree");
});

test("the click moves the caret, unless it lands in the selection", async ({ page }) => {
  await write(page, "one\ntwo\nthree");
  // Select line one, then right-click line three: the selection collapses to
  // the click, so there is nothing to cut or copy and both grey out.
  await page.locator(".cm-line", { hasText: "one" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.locator(".cm-line", { hasText: "three" }).click({ button: "right" });
  const items = menu(page).getByRole("menuitem");
  const at = async (label: string) => items.nth((await labels(page)).indexOf(label));
  await expect(await at("Cut")).toBeDisabled();
  await expect(await at("Copy")).toBeDisabled();
  await expect(await at("Paste")).toBeEnabled(); // the pasteboard is Bun's answer, not ours
  await page.keyboard.press("Escape");

  // Select line one and right-click INSIDE it: the selection survives, which
  // is the whole reason the menu was opened there.
  await page.locator(".cm-line", { hasText: "one" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.locator(".cm-line", { hasText: "one" }).click({ button: "right" });
  await pick(page, "Copy");
  expect(await page.evaluate(() => window.__harness.clipboard())).toBe("one");
});

test("what the pointer landed on leads the menu, and only then", async ({ page }) => {
  await write(page, "plain prose\n\n- [ ] buy milk\n\n[[Alpha]]\n");
  const first = async () => (await labels(page))[0];

  await page.locator(".cm-line", { hasText: "plain prose" }).click({ button: "right" });
  expect(await labels(page)).not.toContain("Open Link");
  expect(await labels(page)).not.toContain("Toggle Checkbox");
  await page.keyboard.press("Escape");

  // A rendered checkbox and a rendered wikilink are both covered by an
  // invisible body-parented hotspot (editor/livePreview.ts) — the pointer hits
  // the hotspot, never the editor, which is why these two clicks are the ones
  // a handler on the editor's own subtree would never hear. Clicking the
  // hotspot is not a contrivance: it is what the pointer does.
  await taskHotspot(page).click({ button: "right" });
  expect(await first()).toBe("Toggle Checkbox");
  await page.keyboard.press("Escape");

  await wikiHotspot(page).click({ button: "right" });
  expect(await first()).toBe("Open Link");
  // And the right-click did not FOLLOW the link: still this note, menu open.
  await expect(page.locator("[data-tab]", { hasText: "Alpha" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Toggle Checkbox from the menu ticks the box under the pointer", async ({ page }) => {
  await write(page, "- [ ] buy milk\n");
  await taskHotspot(page).click({ button: "right" });
  await pick(page, "Toggle Checkbox");
  // Read the text, not the widget: the right-click left the caret on that
  // line, and live preview reveals the markers the caret is on — so the box is
  // raw `[x]` here, exactly as it is after the palette's Toggle Checkbox.
  expect(await raw(page)).toBe("- [x] buy milk\n");
});

test("a runnable block offers both runs; prose and an unterminated fence do not", async ({ page }) => {
  await write(page, "```sh\npwd\n```\n");
  await page.locator(".cm-line", { hasText: "pwd" }).click({ button: "right" });
  expect((await labels(page)).slice(0, 2)).toEqual(["Run Block Inline", "Run Block in Terminal"]);
  await page.keyboard.press("Escape");

  // §4c: an unterminated fence has no agreed body, draws no run pair, and is
  // not offered one here either.
  await write(page, "```sh\npwd\n");
  await page.locator(".cm-line", { hasText: "pwd" }).click({ button: "right" });
  expect(await labels(page)).not.toContain("Run Block Inline");
});

test("a run panel keeps its own gesture: no note menu over a block's output", async ({ page }) => {
  await write(page, "```sh\npwd\n```\n");
  await page.locator(".cm-line", { hasText: "pwd" }).click();
  await page.keyboard.press("Meta+Enter");
  const panel = page.locator(".ledge-output");
  await expect(panel).toBeVisible();
  await panel.locator(".ledge-output-header").click({ button: "right" });
  await expect(menu(page)).toHaveCount(0);
});

test("the manual keeps reading and loses writing", async ({ page }) => {
  // The manual has a window of its own (remote.md §8a), which a spec reaches
  // the way the shell opens it: as that window (docs.spec.ts).
  await page.goto("/harness.html?docs=1");
  await expect(noteRow(page, "Getting Started")).toBeVisible();
  await page.locator(".cm-line").first().click({ button: "right" });
  // Copy and Select All survive — copying a command out of the docs is what
  // the docs are for. Everything that would write is absent, not greyed.
  expect(await labels(page)).toEqual(["Copy", "Select All"]);
});
