// A drawer another client took (remote.md §7, interactions.md §4-2).
//
// One note's shell has one drawer across the whole server, not one per client.
// Attaching takes it, and the client it was taken from gets a
// `terminalDetached` push. What that push has to produce is the whole of this
// file. Without it the terminal stops printing with no explanation and goes on
// swallowing keystrokes. That looks like a hung app.
//
// PTYs are inert in the harness, so the shell prints nothing. What a spec can
// see is the view's half: the notice, the keystrokes that stop, and the attach
// that takes it back. `__harness.terminalTaken` stands in for the push, since
// the action that causes it happens on the other client.
import { expect, test } from "@playwright/test";

const attaches = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__harness.termAttaches().length);
const typed = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__harness.termInputs().length);

// The attach count once the drawer is open. Opening costs more than one
// attach, since StrictMode mounts the drawer twice in a dev build, so these
// specs measure the next attach rather than the total.
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

  // The taken drawer stops sending keystrokes, not just showing a notice. The
  // window still has focus, so without the drawer's `mine` gate these would be
  // sent (terminal/TerminalDrawer.tsx). Bun refuses input from a client that
  // does not own the shell (bun/server.ts terminalInput), so they would be
  // dropped without a word.
  await page.keyboard.type("cd /");
  await expect.poll(() => typed(page)).toBe(2);

  // Taking it back sends one more attach, the same call the drawer makes when
  // it opens. That attach is what brings the scrollback back.
  await page.getByRole("button", { name: "Take This Shell" }).click();
  await expect(page.getByTestId("terminal-taken")).toHaveCount(0);
  await expect.poll(() => attaches(page)).toBe(opened + 1);

  // Clicking the button takes focus off the terminal. The take-back attach
  // calls `term.focus()` (terminal/TerminalDrawer.tsx attach), so the terminal
  // has the keyboard again. Without that there would be nowhere to type.
  await page.keyboard.type("cd");
  await expect.poll(() => typed(page)).toBe(4);
});

test("the drawer sizes a shell it owns, and sizes it again when it takes it back", async ({ page }) => {
  // A resize is the owner's call, so the drawer cannot send one before the
  // attach that makes it the owner. The drawer used to send the resize first,
  // and Bun spawned the shell to answer it. A resize carries no host, so that
  // spawn threw away the host the picker had chosen (bun/server.ts
  // terminalResize).
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

  // Taking it back sizes the shell to this window. The client that had it may
  // have had a window of a different size, and the pty keeps the size it was
  // last told.
  await expect.poll(async () => (await resizes()).length).toBeGreaterThan(before);
});

// The push names a client id, and the presence list says what that client is
// called (remote.md §7). The notice shows that name, so a user can see which
// machine has the shell.
test("the notice names the device that took the shell", async ({ page }) => {
  const sessionId = await page.evaluate(() => {
    const seen = window.__harness.termAttaches();
    return seen[seen.length - 1].sessionId;
  });

  await page.evaluate(() => window.__harness.presence([{ client: "phone-1", label: "iPhone" }]));
  await page.evaluate((sid) => window.__harness.terminalTaken(sid, "phone-1"), sessionId);
  await expect(page.getByText("iPhone took this shell.")).toBeVisible();

  // The notice keeps the name after the taker disconnects. It describes a
  // moment that has already happened, so its wording must not follow the
  // presence list afterwards. `labelFor` resolves the name when the push
  // arrives and the drawer stores the string it returns (lib/connections.ts,
  // terminal/TerminalDrawer.tsx onTerminalDetached).
  await page.evaluate(() => window.__harness.presence([]));
  await expect(page.getByText("iPhone took this shell.")).toBeVisible();
});

test("a taker nobody has a name for is still explained", async ({ page }) => {
  const sessionId = await page.evaluate(() => {
    const seen = window.__harness.termAttaches();
    return seen[seen.length - 1].sessionId;
  });

  await page.evaluate((sid) => window.__harness.terminalTaken(sid, "who-1"), sessionId);
  await expect(page.getByText("Another device took this shell.")).toBeVisible();
});

test("a note whose drawer was taken is not the note beside it", async ({ page }) => {
  // The push names a session, and a drawer showing another note must ignore it:
  // one stale sessionId would put the notice over a shell nobody touched.
  await page.evaluate(() => window.__harness.terminalTaken("some-other-note"));
  await expect(page.getByTestId("terminal-taken")).toHaveCount(0);
  await page.keyboard.type("x");
  await expect.poll(() => typed(page)).toBe(1);
});
