// The note editor's context menu (interactions.md §11), driven end to end in
// headless WebKit. commands/editorMenu.test.ts covers which verbs a click
// calls for. These cases cover the rest: a right-click on a hotspot over a
// rendered link still reaches the window listener, the caret moves to the
// pointer, and a menu item does what its chord does.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const menu = (page: Page) => page.getByRole("menu");
// Find the invisible hotspots over a rendered checkbox and a rendered
// wikilink by the tooltip each carries. The link layer floats them over the
// editor (editor/livePreview.ts).
const taskHotspot = (page: Page) => page.locator(".ledge-hotspot[title='Toggle Checkbox']");
const wikiHotspot = (page: Page) => page.locator(".ledge-hotspot[title='Click to open note']");

// Every item the open menu carries, in order, label only. The key chip is
// the button's second child (components/ContextMenu.tsx), so read the first.
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
// exactly as spelled. Typing it would trigger autoclose and open the `[[`
// picker.
async function write(page: Page, body: string): Promise<void> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(body);
}

// The document as written, read back through the clipboard seam. That is the
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
  // The menu is a modal layer, so Escape closes it (commands/layers.ts).
  // Escape changes nothing else: the note still reads as it was written.
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
  // Paste is never greyed: `when` runs synchronously on every menu render,
  // and reading the pasteboard takes an async round trip to Bun
  // (commands/registry.ts).
  await expect(await at("Paste")).toBeEnabled();
  await page.keyboard.press("Escape");

  // Select line one and right-click inside it: the selection survives, so
  // Copy still has something to copy.
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

  // An invisible hotspot parented to the body covers each rendered checkbox
  // and rendered wikilink (editor/livePreview.ts). The pointer hits the
  // hotspot, not the editor. A handler on the editor's own subtree would
  // never hear these two clicks, so the spec clicks the hotspot, where a
  // real pointer lands.
  await taskHotspot(page).click({ button: "right" });
  expect(await first()).toBe("Toggle Checkbox");
  await page.keyboard.press("Escape");

  await wikiHotspot(page).click({ button: "right" });
  expect(await first()).toBe("Open Link");
  // The right-click did not follow the link: still this note, menu open.
  await expect(page.locator("[data-tab]", { hasText: "Alpha" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Toggle Checkbox from the menu ticks the box under the pointer", async ({ page }) => {
  await write(page, "- [ ] buy milk\n");
  await taskHotspot(page).click({ button: "right" });
  await pick(page, "Toggle Checkbox");
  // Assert on the text, not on the rendered checkbox. raw() copies the
  // document source through the clipboard seam, so the box reads as raw
  // `[x]` whatever live preview draws. The menu runs the same task.toggle
  // command the palette does (commands/registry.ts).
  expect(await raw(page)).toBe("- [x] buy milk\n");
});

test("a runnable block offers both runs; prose and an unterminated fence do not", async ({ page }) => {
  await write(page, "```sh\npwd\n```\n");
  await page.locator(".cm-line", { hasText: "pwd" }).click({ button: "right" });
  expect((await labels(page)).slice(0, 2)).toEqual(["Run Block Inline", "Run Block in Terminal"]);
  await page.keyboard.press("Escape");

  // An unterminated fence has no agreed body and draws no run pair
  // (interactions.md §4c). The menu offers it no run either.
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
  // The manual opens in a window of its own (remote.md §8a). Loading
  // /harness.html?docs=1 makes this page that window, the route docs.spec.ts
  // takes too.
  await page.goto("/harness.html?docs=1");
  await expect(noteRow(page, "Getting Started")).toBeVisible();
  await page.locator(".cm-line").first().click({ button: "right" });
  // Copy and Select All survive, so a reader can copy a command out of the
  // manual. Everything that would write is absent, not greyed.
  expect(await labels(page)).toEqual(["Copy", "Select All"]);
});

// Spell checking (interactions.md §12). The harness dictionary knows one
// misspelling, "recieve". WebKit's squiggles are not observable from a page, so
// these cover the attributes that decide what WebKit checks, and the menu.
test.describe("spelling", () => {
  // The line holding `text`, and the right-click on the word itself.
  const lineWith = (page: Page, text: string) => page.locator(".cm-line", { hasText: text });
  async function rightClickWord(page: Page, word: string): Promise<void> {
    const box = await page.evaluate((w) => {
      const walker = document.createTreeWalker(document.querySelector(".cm-content")!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(w);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i + 1);
        r.setEnd(n, i + 2);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      return null;
    }, word);
    expect(box, `no "${word}" in the note`).not.toBeNull();
    await page.mouse.click(box!.x, box!.y, { button: "right" });
  }

  test("prose is checked, and code, URLs and tags are marked out of it", async ({ page }) => {
    await write(page, "I recieve mail at https://exampel.com with #tagg.\n\n```bash\necho recieve\n```\n");
    await expect(page.locator(".cm-content").first()).toHaveAttribute("spellcheck", "true");
    await expect(page.locator(".cm-content").first()).toHaveAttribute("autocorrect", "off");
    await expect(lineWith(page, "echo recieve")).toHaveAttribute("spellcheck", "false");
    await expect(lineWith(page, "I recieve")).not.toHaveAttribute("spellcheck", "false");
    await expect(page.locator('.cm-content [spellcheck="false"]', { hasText: "https://exampel.com" })).toHaveCount(1);
    await expect(page.locator('.cm-content [spellcheck="false"]', { hasText: "#tagg" })).toHaveCount(1);
  });

  test("a misspelled word offers its guesses first, and a guess replaces it", async ({ page }) => {
    await write(page, "I recieve mail");
    await rightClickWord(page, "recieve");
    await expect(menu(page)).toBeVisible();
    expect((await labels(page)).slice(0, 4)).toEqual(["receive", "relieve", "Learn Spelling", "Cut"]);
    await pick(page, "receive");
    expect(await raw(page)).toBe("I receive mail");
  });

  test("Learn Spelling adds the word to the dictionary and changes nothing in the note", async ({ page }) => {
    await write(page, "I recieve mail");
    await rightClickWord(page, "recieve");
    await pick(page, "Learn Spelling");
    expect(await page.evaluate(() => window.__harness.learnedWords())).toEqual(["recieve"]);
    expect(await raw(page)).toBe("I recieve mail");
  });

  test("a correct word, and a misspelling inside a fence, offer no spelling", async ({ page }) => {
    await write(page, "I receive mail\n\n```bash\necho recieve\n```\n");
    await rightClickWord(page, "receive");
    await expect(menu(page)).toBeVisible();
    expect((await labels(page))[0]).toBe("Cut");
    await page.keyboard.press("Escape");
    await rightClickWord(page, "recieve");
    await expect(menu(page)).toBeVisible();
    expect(await labels(page)).not.toContain("Learn Spelling");
    // The fence's word never reached the dictionary at all.
    expect(await page.evaluate(() => window.__harness.spellingAsks())).not.toContain("recieve");
  });

  test("with editor.spellCheck off, nothing is checked and the menu never asks", async ({ page }) => {
    await page.goto("/harness.html?spellCheck=off");
    await expect(noteRow(page, "Alpha")).toBeVisible();
    await page.keyboard.press("Meta+n");
    await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
    await write(page, "I recieve mail");
    await expect(page.locator(".cm-content").first()).toHaveAttribute("spellcheck", "false");
    await rightClickWord(page, "recieve");
    await expect(menu(page)).toBeVisible();
    expect((await labels(page))[0]).toBe("Cut");
    expect(await page.evaluate(() => window.__harness.spellingAsks())).toEqual([]);
  });
});
