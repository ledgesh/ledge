// A drawer another client took (remote.md §7, interactions.md §4-2).
//
// One note's shell has one drawer across the whole server, not one per client:
// attaching takes it, and the client it was taken from gets a `terminalDetached`
// push. What that push has to produce is the whole of this file — a terminal
// that stops printing with no explanation and goes on swallowing keystrokes is
// the failure the push exists to prevent, and it looks exactly like a hung app.
//
// PTYs are inert in the harness, so the shell never speaks; what a spec can see
// is the view's half — the notice, the keystrokes that stop, and the attach that
// takes it back. `__harness.terminalTaken` stands in for the push, since the
// action that causes it happens on the OTHER client.
import { expect, test } from "@playwright/test";

const attaches = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__harness.termAttaches().length);
const typed = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__harness.termInputs().length);

// How many attaches the open itself cost, which is not one: StrictMode mounts
// the drawer twice in a dev build, so what these specs measure is the NEXT
// attach rather than the total.
let opened = 0;

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.getByTitle("Toggle Terminal", { exact: false }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await expect.poll(() => attaches(page)).toBeGreaterThan(0);
  opened = await attaches(page);
});

test("a drawer another client takes says so, and hands the keyboard back when taken again", async ({ page }) => {
  const sessionId = await page.evaluate(() => {
    const seen = window.__harness.termAttaches();
    return seen[seen.length - 1].sessionId;
  });

  // The drawer is this client's: it focused the terminal on open, and what is
  // typed there reaches the shell.
  await page.keyboard.type("ab");
  await expect.poll(() => typed(page)).toBe(2);

  await page.evaluate((sid) => window.__harness.terminalTaken(sid), sessionId);
  await expect(page.getByTestId("terminal-taken")).toBeVisible();
  await expect(page.getByText("Another device took this shell.")).toBeVisible();

  // And it is inert, not merely explained. The window kept its focus, so
  // without this the keystrokes would keep going at a shell whose output is on
  // another screen.
  await page.keyboard.type("cd /");
  await expect.poll(() => typed(page)).toBe(2);

  // Taking it back is one more attach — the same call the drawer makes when it
  // opens, which is what brings the scrollback with it.
  await page.getByRole("button", { name: "Take This Shell" }).click();
  await expect(page.getByTestId("terminal-taken")).toHaveCount(0);
  await expect.poll(() => attaches(page)).toBe(opened + 1);

  // The button had focus when it was clicked; the terminal has it now, or
  // taking the shell back would leave nowhere to type.
  await page.keyboard.type("cd");
  await expect.poll(() => typed(page)).toBe(4);
});

test("the drawer sizes a shell it owns, and sizes it again when it takes it back", async ({ page }) => {
  // A resize is the owner's call now, so the drawer cannot send one before the
  // attach that makes it the owner. It used to send one first, and Bun spawned
  // the shell to answer it — which threw away the host the picker had chosen,
  // since a resize carries no host to spawn on.
  const resizes = () => page.evaluate(() => window.__harness.termResizes());
  await expect.poll(async () => (await resizes()).length).toBeGreaterThan(0);
  for (const r of await resizes()) {
    expect(r.afterAttach).toBeGreaterThan(0);
    expect(r.cols).toBeGreaterThan(0);
    expect(r.rows).toBeGreaterThan(0);
  }

  const sessionId = await page.evaluate(() => {
    const seen = window.__harness.termAttaches();
    return seen[seen.length - 1].sessionId;
  });
  const before = (await resizes()).length;
  await page.evaluate((sid) => window.__harness.terminalTaken(sid), sessionId);
  await page.getByRole("button", { name: "Take This Shell" }).click();

  // Taking it back re-sizes the shell to THIS window: the client it came from
  // may have had a different one, and the pty keeps whatever it was last told.
  await expect.poll(async () => (await resizes()).length).toBeGreaterThan(before);
});

test("a note whose drawer was taken is not the note beside it", async ({ page }) => {
  // The push names a session, and a drawer showing another note must ignore it:
  // one stale sessionId would put the notice over a shell nobody touched.
  await page.evaluate(() => window.__harness.terminalTaken("some-other-note"));
  await expect(page.getByTestId("terminal-taken")).toHaveCount(0);
  await page.keyboard.type("x");
  await expect.poll(() => typed(page)).toBe(1);
});
