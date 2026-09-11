// What closes a fenced block, and which blocks draw no run pair.
//
// An opener closes its own fence, on the third mark and on Enter, even when
// another block already sits below it (editor/fences.ts). Without that, the
// closer below pairs with the new opener and swallows the block between them.
// An unterminated block draws no run pair and refuses the chord
// (editor/blocks.ts, interactions.md §4c): Lezer ends an unclosed node on the
// last body line, so the body read from it used to be one line short. A
// one-line block gave the shell an empty file, so the run printed nothing and
// reported exit 0.
import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
});

// Replace the note with `body`. Written whole rather than typed, so the fences
// land exactly as spelled (autoclose would otherwise answer the openers).
async function write(page: Page, body: string) {
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(body);
}

// The document as written, read back through the clipboard seam (lists.spec.ts).
async function raw(page: Page): Promise<string> {
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  const text = await page.evaluate(() => window.__harness.clipboard());
  await page.keyboard.press("ArrowRight"); // collapse to the end
  return text;
}

test("a fence typed above an existing block closes there and then", async ({ page }) => {
  await write(page, "\n```sh\npwd\n```\n");
  await page.locator(".cm-line").first().click();
  await page.keyboard.type("```");

  // The closer arrives with the third backtick, so the block below is never
  // swallowed. It is still its own block, and still offers to run.
  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  expect(await raw(page)).toBe("```\n```\n```sh\npwd\n```\n");
});

test("Enter closes an opener that arrived some other way", async ({ page }) => {
  // The body is written whole, the way a paste or a note saved mid-block
  // arrives. Nothing is typed, so the note opens with the two blocks merged
  // into one.
  await write(page, "```\n\n```sh\npwd\n```\n");
  await expect(page.locator('[data-act="run"]')).toHaveCount(0);

  await page.locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");

  expect(await raw(page)).toBe("```\n\n```\n\n```sh\npwd\n```\n");
});

test("an unterminated fence draws no run pair, and its copy button still copies the body", async ({ page }) => {
  // No trailing newline: the note stops mid-block. That is the shape that
  // used to hand `source` an empty file.
  await write(page, "# Untitled\n\n```sh\npwd\n```\n\n```sh\nls");

  // Two blocks, one closed and one open. Only the closed one gets a run pair.
  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  await expect(page.locator('[data-act="term"]')).toHaveCount(1);
  const groups = page.locator(".ledge-ctl-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1).locator("button")).toHaveCount(1); // copy alone

  // Copy and the runner read the same body (`block.code`, editor/blocks.ts).
  // An unclosed block's body is every line after the opener: the last line is
  // content, not a fence.
  await groups.nth(1).locator("button").dispatchEvent("mousedown", { button: 0 });
  await expect.poll(() => page.evaluate(() => window.__harness.clipboard())).toBe("ls");
});

test("the chord refuses an unterminated fence and says why", async ({ page }) => {
  await write(page, "# Untitled\n\n```sh\nls");
  await page.locator(".cm-line", { hasText: "ls" }).click();

  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("no closing fence", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);

  // The terminal destination is held to the same rule.
  await page.keyboard.press("Meta+Shift+Enter");
  expect(await page.evaluate(() => window.__harness.termPastes())).toHaveLength(0);
});

test("typing the closing fence brings the run pair with it", async ({ page }) => {
  await write(page, "# Untitled\n\n```sh\nls");
  await expect(page.locator('[data-act="run"]')).toHaveCount(0);

  await page.locator(".cm-line", { hasText: "ls" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("```");

  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  await page.keyboard.press("Meta+Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
});

// The other way a block draws no run pair: `norun` in the info string
// (interactions.md §4e). Without the mark, a command quoted for some other
// machine is a live button on whichever machine shows the note. Every fence
// in a runnable language in docs/user/ carries it, and any note can use it.
test("a fence marked norun draws copy alone, and the chord says why", async ({ page }) => {
  await write(page, "# Untitled\n\n```sh\npwd\n```\n\n```sh norun\nsudo apt-get install -y restic\n```\n");

  // The marked block is closed and its language is runnable; the word alone
  // takes the pair away. Copy stays, because copying is not running.
  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  await expect(page.locator('[data-act="term"]')).toHaveCount(1);
  const groups = page.locator(".ledge-ctl-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1).locator("button")).toHaveCount(1);
  await groups.nth(1).locator("button").dispatchEvent("mousedown", { button: 0 });
  await expect.poll(() => page.evaluate(() => window.__harness.clipboard())).toBe("sudo apt-get install -y restic");

  await page.locator(".cm-line", { hasText: "apt-get" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("marked norun", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);
  await page.keyboard.press("Meta+Shift+Enter");
  expect(await page.evaluate(() => window.__harness.termPastes())).toHaveLength(0);
});

test("typing norun onto a fence takes the pair away, and deleting it brings it back", async ({ page }) => {
  await write(page, "# Untitled\n\n```sh\npwd\n```\n");
  await expect(page.locator('[data-act="run"]')).toHaveCount(1);

  // The opener is reached from the body line below it. Clicking `pwd` puts
  // the selection inside the block, which reveals the fence marks concealed
  // while the selection is off it (editor/livePreview.ts reveals the whole
  // FencedCode node). ArrowUp then End lands after `sh` on the opener line.
  await page.locator(".cm-line", { hasText: "pwd" }).click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type(" norun");
  await expect(page.locator('[data-act="run"]')).toHaveCount(0);

  for (let i = 0; i < " norun".length; i += 1) await page.keyboard.press("Backspace");
  await expect(page.locator('[data-act="run"]')).toHaveCount(1);
});

test("an indented body line leaves the card's left edge straight", async ({ page }) => {
  // The card is drawn per line (editor/blocks.ts), and the hanging indent
  // (editor/wrap.ts) used to shift an indented line right with `margin-left`,
  // taking that line's slice of the card with it and notching the edge. Inside
  // a fence the shift goes into the padding instead, so every line's box
  // starts in the same column.
  await write(page, "# Untitled\n\n```sh\n  ls -a ~/ledge\n```\n");
  const lines = page.locator(".cm-line.ledge-code");
  await expect(lines).toHaveCount(3);
  const lefts = await lines.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
  expect(new Set(lefts).size).toBe(1);

  // The indent itself survives: the code's first character still sits two
  // columns in from the card's own inset.
  const [inset, first] = await page.evaluate(() => {
    const line = document.querySelectorAll<HTMLElement>(".cm-line.ledge-code")[1]!;
    const range = document.createRange();
    range.setStart(line.firstChild!, 2);
    range.setEnd(line.firstChild!, 3);
    return [line.getBoundingClientRect().left, range.getBoundingClientRect().left];
  });
  expect(first - inset).toBeGreaterThan(12);
});
