// What a reconnect does to a drawer that is already open (rpc-schema
// terminalClaim, remote.md §7).
//
// The wire dropping does not stop the shell: it keeps printing on the server,
// at a connection that is gone, and a push with nowhere to go is dropped rather
// than queued (bun/daemon.ts). So a client that comes back is holding a
// terminal with a hole in it — and it may also be holding one whose shell has
// since moved to another device, or ended, because those two pushes were
// dropped as well. Coming back is therefore when the drawer asks, and these
// state all three answers.
//
// The sibling of inline-reconnect.spec.ts, which does the same for run panels.
// PTYs are inert here; `__harness.shellClaim` is the fake server's side of the
// question and `__harness.linkState` is the wire coming back.
import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

const claims = (page: Page) => page.evaluate(() => window.__harness.shellClaims());
const typed = (page: Page) => page.evaluate(() => window.__harness.termInputs().length);

// `others` is who the server says is here, announced as part of coming back.
// Faithful ordering rather than a convenience: a dropped wire clears the
// presence list (lib/connections.ts, since a wire that is down cannot say who
// left), and the daemon announces the list again when a connection registers —
// which is written to the wire before any answer to a request this client sends
// afterwards. So a claim answered "held" always resolves its name against a
// refilled list, and a spec that set presence later would be testing an order
// the app never sees.
async function reconnect(page: Page, others: { client: string; label: string }[] = []) {
  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await page.evaluate((list) => window.__harness.presence(list), others);
  await page.evaluate(() => window.__harness.linkState("live", ""));
}

async function sessionId(page: Page) {
  return page.evaluate(() => {
    const seen = window.__harness.termAttaches();
    return seen[seen.length - 1].sessionId;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  // A scratch note rather than a seeded one, because this file clicks into the
  // editor to say where the keyboard is and one of the seeded notes opens
  // behind its lock face.
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.getByTitle("Toggle Terminal", { exact: false }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await expect.poll(async () => (await page.evaluate(() => window.__harness.termAttaches())).length).toBeGreaterThan(0);
});

// The promise the user is given: a build carries on while you are on a train,
// and its output is waiting when you come back
// (docs/user/18-notes-on-another-machine.md). What makes it true is that the
// bytes were kept in the server's ring and the drawer asks for them.
test("an open drawer replays what its shell printed while the wire was down", async ({ page }) => {
  await page.evaluate(() =>
    window.__harness.shellClaim({ state: "attached", dataB64: btoa("while-you-were-out"), host: "local" }),
  );

  await reconnect(page);

  await expect.poll(() => claims(page)).toHaveLength(1);
  expect(await claims(page)).toEqual([await sessionId(page)]);
  // On the screen, not merely fetched. The whole scrollback comes back and is
  // written over a reset terminal, so this is the shell's history rather than
  // an update appended to a stale one.
  await expect(page.locator(".xterm-rows")).toContainText("while-you-were-out");
});

// A reconnect is not a person asking for anything, so it must not move the
// keyboard. The take-back button focuses the terminal because somebody pressed
// it; a wire coming back while the caret is in the note has to leave it there.
test("a replay does not take the keyboard out of the note", async ({ page }) => {
  await page.locator(".cm-line").first().click();
  await page.evaluate(() =>
    window.__harness.shellClaim({ state: "attached", dataB64: btoa("output"), host: "local" }),
  );

  await reconnect(page);
  await expect(page.locator(".xterm-rows")).toContainText("output");

  const before = await typed(page);
  await page.keyboard.type("xy");
  // Into the note, which now reads it back; the shell was sent nothing.
  await expect(page.locator(".cm-line").first()).toContainText("xy");
  expect(await typed(page)).toBe(before);
});

// The `terminalDetached` that would have said so was dropped with everything
// else, so without the claim this drawer would sit looking like it still had a
// shell, swallowing keystrokes the server refuses.
test("a shell another device took while the wire was down explains itself on reconnect", async ({ page }) => {
  await page.evaluate(() => window.__harness.shellClaim({ state: "held", by: "phone-1" }));

  await reconnect(page, [{ client: "phone-1", label: "iPhone" }]);

  await expect(page.getByTestId("terminal-taken")).toBeVisible();
  await expect(page.getByText("iPhone took this shell.")).toBeVisible();
  // And inert, exactly as a drawer that was told at the time would be.
  const before = await typed(page);
  await page.keyboard.type("rm -rf /");
  expect(await typed(page)).toBe(before);
});

// Once the notice is up this client knows the shell is elsewhere, and a wire
// coming back is not a reason to want it back. Taking it is the button's job:
// claiming here would pull the shell off a device somebody deliberately moved
// it to, and the person on that device never touched anything.
test("a drawer that already lost its shell claims nothing", async ({ page }) => {
  await page.evaluate((sid) => window.__harness.terminalTaken(sid, "phone-1"), await sessionId(page));
  await expect(page.getByTestId("terminal-taken")).toBeVisible();

  await reconnect(page);

  await expect(page.getByTestId("terminal-taken")).toBeVisible();
  expect(await claims(page)).toEqual([]);

  // Silence proves nothing on its own — a drawer that never claims at all would
  // also say nothing here. So take the shell back and drop the wire again: the
  // claim that follows is what shows the first reconnect was declining rather
  // than failing to ask.
  await page.getByRole("button", { name: "Take This Shell" }).click();
  await expect(page.getByTestId("terminal-taken")).toHaveCount(0);

  await reconnect(page);
  await expect.poll(() => claims(page)).toHaveLength(1);
});

// A shell can end while its client is unreachable: it exited, or another device
// restarted it to apply edited frontmatter. Attaching would lazily spawn a
// REPLACEMENT and answer with its empty scrollback, which reads as a terminal
// that wiped itself; the drawer closes instead, exactly as it does for the
// `terminalExit` that was dropped.
test("a shell that ended while the wire was down closes the drawer", async ({ page }) => {
  await page.evaluate(() => window.__harness.shellClaim({ state: "gone" }));

  await reconnect(page);

  await expect(page.locator(".xterm")).toHaveCount(0);
});
