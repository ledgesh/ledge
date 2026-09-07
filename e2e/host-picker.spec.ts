// The host picker (components/HostPicker.tsx, interactions.md §4a). A block
// on a note declaring more than one `host:` does not run until the user names
// a machine. PTYs are inert here, so these specs assert policy: when the
// picker opens, what it preselects, and which host the run names.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  // A new note is just an H1. This replaces the whole document with one that
  // has an ```sh block to run; typeFrontmatter below prepends the `host:`
  // lines above it. insertText, not typed keys: a typed third backtick plants
  // a closing fence of its own (editor/fences.ts).
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText('# Untitled\n\n```sh\necho "ready"\n```\n');
  await expect(page.locator(".cm-line", { hasText: 'echo "ready"' })).toBeVisible();
});

async function typeFrontmatter(page: import("@playwright/test").Page, hostLine: string) {
  await page.keyboard.press("Meta+ArrowUp"); // caret to doc start
  for (const line of ["---", hostLine, "---"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await expect(page.locator(".cm-line.ledge-fm-fence")).toHaveCount(2);
}

test("two declared hosts: nothing runs until one is chosen; Enter takes the focused pick", async ({ page }) => {
  await typeFrontmatter(page, "host: web1 db2");
  await page.locator(".cm-line", { hasText: "echo" }).click();
  await page.keyboard.press("Meta+Enter");

  // The picker is up, and the keypress itself dispatched no run.
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "web1" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "db2" })).toBeVisible();
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);

  // With no prior pick this session, the first item is focused. Enter
  // activates that row, and its pick starts the run.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
  expect((await page.evaluate(() => window.__harness.inlineRuns()))[0].host).toBe("web1");
});

test("the picker preselects the session's last pick; arrows move it", async ({ page }) => {
  await typeFrontmatter(page, "host: web1 db2");
  await page.locator(".cm-line", { hasText: "echo" }).click();

  // First run: pick db2 via arrow.
  await page.keyboard.press("Meta+Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);

  // The run never finishes here, because PTYs are inert, so its panel stays
  // up. editor/blocks.ts allows one live run per block, so a second ⌘↵ on
  // this block would start nothing. Dismissing the panel removes the run and
  // frees the block.
  await page.getByTitle("Dismiss").click();
  await page.locator(".cm-line", { hasText: "echo" }).click();

  // Second run: db2 is the preselection now, so Enter alone repeats it.
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "db2" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(2);
  expect((await page.evaluate(() => window.__harness.inlineRuns()))[1].host).toBe("db2");
});

test("Escape dismisses without running anything", async ({ page }) => {
  await typeFrontmatter(page, "host: web1 db2");
  await page.locator(".cm-line", { hasText: "echo" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);
});

test("one declared host runs silently on it — the picker is only for ambiguity", async ({ page }) => {
  await typeFrontmatter(page, "host: web1");
  await page.locator(".cm-line", { hasText: "echo" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
  expect((await page.evaluate(() => window.__harness.inlineRuns()))[0].host).toBe("web1");
});

test("no host key at all still runs local, exactly as before hosts existed", async ({ page }) => {
  await page.locator(".cm-line", { hasText: "echo" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
  expect((await page.evaluate(() => window.__harness.inlineRuns()))[0].host).toBeNull();
});

test("run-in-terminal on a multi-host note asks before the shell spawns, and spawns there", async ({ page }) => {
  await typeFrontmatter(page, "host: web1 db2");
  await page.locator(".cm-line", { hasText: "echo" }).click();
  await page.keyboard.press("Meta+Shift+Enter");

  // The picker opens first. The shell is not spawned until a host is chosen.
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "db2" }).click();

  // The drawer is up. The last attach names db2, so the shell was spawned on
  // the machine that was chosen, and the paste went to that same session.
  await expect(page.locator(".xterm")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__harness.termPastes())).toHaveLength(1);
  const { paste, attaches } = await page.evaluate(() => ({
    paste: window.__harness.termPastes()[0],
    attaches: window.__harness.termAttaches(),
  }));
  expect(attaches[attaches.length - 1]).toEqual({ sessionId: paste.sessionId, host: "db2" });
  // The drawer's own title row carries a host badge naming db2 (App.tsx). It
  // sits outside <header>, which is why the selector reaches header's
  // siblings. `.first()` lands on the editor's `host: web1 db2` span, which
  // comes earlier in the DOM, so this checks the note text, not the badge.
  await expect(page.locator("header ~ * span", { hasText: "db2" }).first()).toBeVisible();
});
