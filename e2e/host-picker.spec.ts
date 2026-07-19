// The host picker (components/HostPicker.tsx): a note declaring more than one
// `host:` must never execute a block until the user names the machine — every
// run, deliberately, with the session's last pick merely preselected. One
// declared host (or none) runs silently with that answer. PTYs are inert in
// the harness; what these specs assert is the POLICY: when the picker
// interposes, what it preselects, and which host the eventual run names.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  // A fresh scratch note is header-only; give it a ```sh block to run, then
  // prepend frontmatter above it (the fence must open on its own line).
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

  // The picker is up, and NO run was dispatched by the keypress itself.
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "web1" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "db2" })).toBeVisible();
  expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);

  // First item is focused (no prior pick), so Enter runs on it.
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

  // Dismiss the (forever-running: PTYs are inert here) panel so the block is
  // free to run again — one live run per block gates re-running.
  await page.getByTitle("Dismiss").click();
  await page.locator(".cm-line", { hasText: "echo" }).click();

  // Second run: db2 is the preselection now — Enter alone repeats it.
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

  // The drawer did not open yet: the spawn is what the choice gates.
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "db2" }).click();

  // Drawer up, attach carried the pick, and the paste went to that session.
  await expect(page.locator(".xterm")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__harness.termPastes())).toHaveLength(1);
  const { paste, attaches } = await page.evaluate(() => ({
    paste: window.__harness.termPastes()[0],
    attaches: window.__harness.termAttaches(),
  }));
  expect(attaches[attaches.length - 1]).toEqual({ sessionId: paste.sessionId, host: "db2" });
  // The badge says where the drawer's shell lives.
  await expect(page.locator("header ~ * span", { hasText: "db2" }).first()).toBeVisible();
});
