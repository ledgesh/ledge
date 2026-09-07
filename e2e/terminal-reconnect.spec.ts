// What a reconnect does to a terminal drawer that is already open (rpc-schema
// terminalClaim, remote.md §7).
//
// The shell keeps running while the wire is down, printing into a connection
// that is gone. A push with nowhere to go is dropped rather than queued
// (bun/audience.ts, remote.md §7), so the drawer claims its session on
// reconnect. The server answers with the output that was missed, with the
// device that took the shell, or with the news that the shell ended.
//
// PTYs are inert here. `__harness.shellClaim` is the fake server's answer, and
// `__harness.linkState` takes the wire down and back up.
import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

const claims = (page: Page) => page.evaluate(() => window.__harness.shellClaims());
const typed = (page: Page) => page.evaluate(() => window.__harness.termInputs().length);

// `others` is who the server says is connected, pushed as part of coming back.
// A dropped wire clears the presence list (lib/connections.ts). The daemon
// pushes it again when a connection registers (bun/daemon.ts
// announcePresence), before the answer to any request that connection sends
// afterwards. Setting presence before "live" stands in for that, so a claim
// answered "held" has a name to resolve.
async function reconnect(page: Page, others: { client: string; label: string }[] = []) {
  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await page.evaluate((list) => window.__harness.presence(list), others);
  await page.evaluate(() => window.__harness.linkState("live", ""));
}

async function drop(page: Page) {
  await page.evaluate(() => window.__harness.linkState("lost", "Lost the connection: the network is unreachable."));
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
  // A scratch note rather than a seeded one. The note that opens at boot is the
  // locked "Codebook" fixture, which shows a lock face rather than an editable
  // document, and one test below clicks into the editor and types there.
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.getByTitle("Toggle Terminal", { exact: false }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await expect.poll(async () => (await page.evaluate(() => window.__harness.termAttaches())).length).toBeGreaterThan(0);
});

// A build keeps running while the client is away, and its output is waiting on
// reconnect (docs/user/09-keep-notes-on-a-remote-server.md). The server's ring
// kept the bytes, and the drawer asks for them.
test("an open drawer replays what its shell printed while the wire was down", async ({ page }) => {
  await page.evaluate(() =>
    window.__harness.shellClaim({ state: "attached", dataB64: btoa("while-you-were-out"), host: "local" }),
  );

  await reconnect(page);

  await expect.poll(() => claims(page)).toHaveLength(1);
  expect(await claims(page)).toEqual([await sessionId(page)]);
  // The check below reads the terminal screen, not just the claim's response.
  // The claim's snapshot is the whole scrollback and it is written over a reset
  // terminal, so this is the shell's history rather than an update appended to
  // a stale one.
  await expect(page.locator(".xterm-rows")).toContainText("while-you-were-out");
});

// A reconnect is not a user action, so it must not move the keyboard. The
// take-back button focuses the terminal because somebody pressed it. A wire
// coming back while the caret is in the note leaves it there
// (terminal/TerminalDrawer.tsx).
test("a replay does not take the keyboard out of the note", async ({ page }) => {
  await page.locator(".cm-line").first().click();
  await page.evaluate(() =>
    window.__harness.shellClaim({ state: "attached", dataB64: btoa("output"), host: "local" }),
  );

  await reconnect(page);
  await expect(page.locator(".xterm-rows")).toContainText("output");

  const before = await typed(page);
  await page.keyboard.type("xy");
  // The typing lands in the note and shows there. The shell was sent nothing.
  await expect(page.locator(".cm-line").first()).toContainText("xy");
  expect(await typed(page)).toBe(before);
});

// The `terminalDetached` push that announces the takeover was dropped with
// everything else while the wire was down. Without the claim, the drawer would
// still look like it had the shell, sending keystrokes the server refuses.
test("a shell another device took while the wire was down explains itself on reconnect", async ({ page }) => {
  await page.evaluate(() => window.__harness.shellClaim({ state: "held", by: "phone-1" }));

  await reconnect(page, [{ client: "phone-1", label: "iPhone" }]);

  await expect(page.getByTestId("terminal-taken")).toBeVisible();
  await expect(page.getByText("iPhone took this shell.")).toBeVisible();
  // It also sends nothing, the same as a drawer that got the
  // `terminalDetached` push when the takeover happened.
  const before = await typed(page);
  await page.keyboard.type("rm -rf /");
  expect(await typed(page)).toBe(before);
});

// Once the notice is up, this client knows the shell is elsewhere, and the
// relink handler skips the claim (TerminalDrawer.tsx claims only while `mine`).
// Taking the shell back is the button's job. Claiming on reconnect would pull
// the shell off the device it was moved to, with no warning there.
test("a drawer that already lost its shell claims nothing", async ({ page }) => {
  await page.evaluate((sid) => window.__harness.terminalTaken(sid, "phone-1"), await sessionId(page));
  await expect(page.getByTestId("terminal-taken")).toBeVisible();

  await reconnect(page);

  await expect(page.getByTestId("terminal-taken")).toBeVisible();
  expect(await claims(page)).toEqual([]);

  // Silence proves nothing on its own: a drawer that never claims at all would
  // also say nothing here. Taking the shell back and reconnecting again
  // produces a claim, which shows the first reconnect declined rather than
  // failed to ask.
  await page.getByRole("button", { name: "Take This Shell" }).click();
  await expect(page.getByTestId("terminal-taken")).toHaveCount(0);

  await reconnect(page);
  await expect.poll(() => claims(page)).toHaveLength(1);
});

// A shell can end while its client is unreachable: it exited, or another device
// restarted it to apply edited frontmatter. Attaching spawns a replacement
// shell and answers with its empty scrollback (bun/server.ts terminalAttach),
// which reads as a terminal that wiped itself. The drawer closes instead, the
// same as it does for the `terminalExit` push that was dropped.
test("a shell that ended while the wire was down closes the drawer", async ({ page }) => {
  await page.evaluate(() => window.__harness.shellClaim({ state: "gone" }));

  await reconnect(page);

  await expect(page.locator(".xterm")).toHaveCount(0);
});

// --- the outage itself ------------------------------------------------------

// Keystrokes go out through a `void` request whose rejection nothing reads
// (boot.tsx terminalInput), so a drawer that kept sending them would lose every
// one silently. A terminal that does not echo also looks like one waiting on a
// slow shell. The drawer stops sending while the wire is down, and the notice
// says which of the two this is.
test("a drawer whose wire is down takes nothing, and says why", async ({ page }) => {
  await drop(page);

  await expect(page.getByTestId("terminal-offline")).toBeVisible();
  await expect(page.getByText("Not connected to This Mac.")).toBeVisible();

  const before = await typed(page);
  await page.keyboard.type("rm -rf /");
  expect(await typed(page)).toBe(before);
});

// The offline state is temporary. Leaving it tears nothing down, so the drawer
// sends keystrokes to the shell again as soon as the wire is back. No take-back
// is needed, because this client never lost the shell.
test("the drawer takes keystrokes again when the wire comes back", async ({ page }) => {
  await drop(page);
  await expect(page.getByTestId("terminal-offline")).toBeVisible();

  await reconnect(page);

  await expect(page.getByTestId("terminal-offline")).toHaveCount(0);
  const before = await typed(page);
  await page.locator(".xterm-screen").click();
  await page.keyboard.type("echo hi");
  await expect.poll(() => typed(page)).toBeGreaterThan(before);
});

// The same guard against over-correcting that the run gate keeps in
// inline-reconnect.spec.ts. A request made while the reconnect ladder runs is
// held, then issued once the wire is back (shared/transport.ts), so these
// keystrokes arrive. Refusing them here would throw away typing over a wire
// that was only slow.
test("a wire still being re-dialled does not gate the drawer", async ({ page }) => {
  await page.evaluate(() =>
    window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"),
  );

  await expect(page.getByTestId("terminal-offline")).toHaveCount(0);
  const before = await typed(page);
  await page.keyboard.type("echo hi");
  await expect.poll(() => typed(page)).toBeGreaterThan(before);
});

// A device took the shell, then the wire went, so both notices apply at once.
// The outage notice wins. This client cannot tell from here whether that device
// still has the shell, and the take-back button would send a request that
// cannot go out.
test("the outage outranks a shell another device is holding", async ({ page }) => {
  await page.evaluate((sid) => window.__harness.terminalTaken(sid, "phone-1"), await sessionId(page));
  await expect(page.getByTestId("terminal-taken")).toBeVisible();

  await drop(page);

  await expect(page.getByTestId("terminal-offline")).toBeVisible();
  await expect(page.getByTestId("terminal-taken")).toHaveCount(0);

  // The state underneath survived being covered: the shell is still elsewhere,
  // so the taken notice comes back with the wire.
  await reconnect(page);
  await expect(page.getByTestId("terminal-taken")).toBeVisible();
});
