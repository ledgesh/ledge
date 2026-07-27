// The run confirmation (interactions.md §4b): a fence marked `confirm`, or any
// block in a `confirm: true` note, opens a modal before anything executes.
// PTYs are inert in the harness; what these specs assert is the POLICY: that
// nothing is dispatched while the dialog is up, that Cancel and Escape run
// nothing and remember nothing, and that the marker's absence changes nothing.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
});

// Replace the scratch note with `body`. Written whole rather than typed so the
// fence's info string lands exactly as spelled (autoclose would otherwise
// answer the opener).
async function write(page: import("@playwright/test").Page, body: string) {
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(body);
  await expect(page.locator(".cm-line", { hasText: "rm -rf ./cache" })).toBeVisible();
  await page.locator(".cm-line", { hasText: "rm -rf ./cache" }).click();
}

const BLOCK = (info: string) => `# Untitled\n\n\`\`\`${info}\nrm -rf ./cache\n\`\`\`\n`;

test("a marked fence asks first, and nothing runs until Run is clicked", async ({ page }) => {
  await write(page, BLOCK("sh confirm"));
  await page.keyboard.press("Meta+Enter");

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Run this sh block?");
  // The code is shown: the fence body is the truth about what is about to run.
  await expect(dialog).toContainText("rm -rf ./cache");
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);

  await page.getByRole("alertdialog").getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
});

test("Cancel runs nothing, and the next chord asks again", async ({ page }) => {
  await write(page, BLOCK("sh confirm"));
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);

  // No memory of the answer: a cancelled yes would be the state the marker
  // exists to prevent.
  await page.locator(".cm-line", { hasText: "rm -rf" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("alertdialog")).toBeVisible();
});

test("Escape dismisses without running", async ({ page }) => {
  await write(page, BLOCK("sh confirm"));
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);
});

test("confirm=\"…\" asks the fence's own question", async ({ page }) => {
  await write(page, BLOCK('sh confirm="Wipe the build cache?"'));
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("alertdialog")).toContainText("Wipe the build cache?");
});

test("the marker also gates the terminal destination", async ({ page }) => {
  await write(page, BLOCK("sh confirm"));
  await page.keyboard.press("Meta+Shift+Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("this note's terminal");
  expect(await page.evaluate(() => window.__harness.termPastes())).toHaveLength(0);

  await page.getByRole("alertdialog").getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__harness.termPastes())).toHaveLength(1);
});

test("an unmarked fence still runs straight through", async ({ page }) => {
  await write(page, BLOCK("sh"));
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
});

test("confirm: true in frontmatter covers every block, and one can opt out", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(
    "---\nconfirm: true\n---\n# Untitled\n\n```sh\nrm -rf ./cache\n```\n\n```sh confirm=no\necho safe\n```\n",
  );
  await expect(page.locator(".cm-line", { hasText: "rm -rf ./cache" })).toBeVisible();

  await page.locator(".cm-line", { hasText: "rm -rf ./cache" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // The opted-out block in the same note runs with no dialog at all.
  await page.locator(".cm-line", { hasText: "echo safe" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
});

test("on a multi-host note the machine is chosen first, then named in the question", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("---\nhost: web1 db2\n---\n# Untitled\n\n```sh confirm\nrm -rf ./cache\n```\n");
  await expect(page.locator(".cm-line", { hasText: "rm -rf ./cache" })).toBeVisible();
  await page.locator(".cm-line", { hasText: "rm -rf ./cache" }).click();
  await page.keyboard.press("Meta+Enter");

  // Picker first: on a multi-host note, WHICH MACHINE is the frightening part,
  // so the question has to be able to name it.
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "db2" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("db2");
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);

  await page.getByRole("alertdialog").getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
  expect((await page.evaluate(() => window.__harness.inlineRuns()))[0].host).toBe("db2");
});
