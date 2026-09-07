// What a reconnect does to a panel left on "Running" (remote.md §7), and what
// the outage itself does to one (interactions.md §4d).
//
// A dropped wire pauses nothing: the run keeps going on the server, whose
// events are pushed at a connection that is gone. The server holds those for
// the client they were addressed to and releases them at its next claim
// (bun/server.ts `missed`). The hold only starts once the server knows the
// client has left, so a client that comes back can still show a panel for a
// run that finished in the seconds before that. So the client also asks, on
// every reconnect, which of its runs the server still has (bridge.ts
// reconcileRuns). The specs below cover both halves of that exchange.
//
// While the wire is down the panel says "Disconnected", and:
// - it reports no ending;
// - the block stays gated, so no second run starts over a first that may
//   still be going;
// - the panel stops sending what is typed at it.
//
// PTYs are inert here. `__harness.holdRuns` is the fake server's answer to the
// claim, and `__harness.linkState` takes the wire down and back up.
import { expect, test } from "@playwright/test";

// A scratch note holding one runnable block, caret inside it. Nothing run yet.
async function writeBlock(page: import("@playwright/test").Page) {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Untitled\n\n```sh\nsleep 30\n```\n");
  await page.locator(".cm-line", { hasText: "sleep 30" }).click();
}

// Runs that block inline and returns the new run's id.
async function runBlock(page: import("@playwright/test").Page) {
  await writeBlock(page);
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-status")).toHaveText("Running");
  const runs = await page.evaluate(() => window.__harness.inlineRuns());
  return runs[runs.length - 1].id;
}

// Runs that block and pushes one byte of output at it, since PTYs are inert
// here. That byte also moves the keyboard into the panel: a run's focus claim
// is honored on the first write, when a "Password:" could appear (inlineTerm.ts
// claimFocus). A panel only receives typing while it holds focus.
async function talkingRun(page: import("@playwright/test").Page) {
  const id = await runBlock(page);
  await page.evaluate((runId) => window.__harness.runOutput(runId, "Password:"), id);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".xterm"))).toBe(true);
  return id;
}

const typedAt = (page: import("@playwright/test").Page, id: string) =>
  page.evaluate((runId) => window.__harness.inlineInputs().filter((i) => i.id === runId).length, id);

async function drop(page: import("@playwright/test").Page) {
  await page.evaluate(() => window.__harness.linkState("lost", "Lost the connection: the network is unreachable."));
}

async function dialling(page: import("@playwright/test").Page) {
  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
}

async function reconnect(page: import("@playwright/test").Page) {
  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await page.evaluate(() => window.__harness.linkState("live", ""));
}

test("a panel the server is no longer running is closed out on reconnect", async ({ page }) => {
  const id = await runBlock(page);

  await reconnect(page);

  // The claim names this run's id. The panel is the only record of the run on
  // this side.
  await expect.poll(() => page.evaluate(() => window.__harness.runClaims())).toContainEqual([id]);
  // Unconfirmed by the server, so the panel is closed out with no exit status.
  // Nothing on this side saw what became of the run.
  await expect(page.locator(".ledge-status")).toHaveText("Session ended");
  await expect(page.locator(".ledge-dot-error")).toBeVisible();

  // And the block is runnable again. A block with a live run refuses to start
  // another (blocks.ts isBlockRunning), so a panel stuck on "Running" would
  // keep the block gated until someone dismissed the panel.
  await page.locator(".cm-line", { hasText: "sleep 30" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await page.evaluate(() => window.__harness.inlineRuns())).length).toBe(2);
});

test("a run the server confirms is left alone", async ({ page }) => {
  const id = await runBlock(page);
  await page.evaluate((runId) => window.__harness.holdRuns([runId]), id);

  await reconnect(page);

  await expect.poll(() => page.evaluate(() => window.__harness.runClaims())).toContainEqual([id]);
  await expect(page.locator(".ledge-status")).toHaveText("Running");
  // Still the one live run this block is allowed, so ⌘↩ is refused rather
  // than starting a second run that nothing would ever close.
  await page.locator(".cm-line", { hasText: "sleep 30" }).click();
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(100);
  expect((await page.evaluate(() => window.__harness.inlineRuns())).length).toBe(1);
});

test("a client with no panels claims nothing", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();

  await reconnect(page);

  // The empty claim is sent rather than skipped. It tells the server that none
  // of the runs it is holding for this client still has a panel. The scope is
  // per client, so another client's runs are untouched (bun/server.ts
  // inlineClaim).
  await expect.poll(() => page.evaluate(() => window.__harness.runClaims())).toContainEqual([]);
});

test("a run whose machine goes away says so, and invents no ending", async ({ page }) => {
  await runBlock(page);

  await drop(page);

  // Not "Session ended", which is what a dropped wire used to produce. The
  // program may be four minutes into a deploy, and all this client knows is
  // that the wire went down (blocks.ts setRunsLink, which replaced a
  // failAllRuns).
  await expect(page.locator(".ledge-status")).toHaveText("Disconnected");
  await expect(page.locator(".ledge-dot-unknown")).toBeVisible();
  // And the panel is still on screen. Nothing is torn down on the way out, and
  // the panel is the only record of the run this client has left to claim with
  // when it comes back.
  await expect(page.locator("[data-ledge-run]")).toBeVisible();
});

test("a run the server kept is picked back up where it left off", async ({ page }) => {
  const id = await runBlock(page);
  await drop(page);
  await expect(page.locator(".ledge-status")).toHaveText("Disconnected");
  await page.evaluate((runId) => window.__harness.holdRuns([runId]), id);

  await reconnect(page);

  // The claim names this run even though the outage left the client unsure
  // whether it survived. runningRunIds counts "unknown" runs alongside
  // "running" ones (blocks.ts), so the id is named from either side of the
  // relink. A claim listing only the certain runs would have the server
  // interrupt exactly the ones the outage made uncertain.
  await expect.poll(() => page.evaluate(() => window.__harness.runClaims())).toContainEqual([id]);
  await expect(page.locator(".ledge-status")).toHaveText("Running");
});

test("a run that died during the outage is closed out, not left unknown", async ({ page }) => {
  await runBlock(page);
  await drop(page);
  await expect(page.locator(".ledge-status")).toHaveText("Disconnected");

  await reconnect(page);

  await expect(page.locator(".ledge-status")).toHaveText("Session ended");
  await expect(page.locator(".ledge-dot-error")).toBeVisible();
});

test("a block will not start a run at a machine that is not there", async ({ page }) => {
  await writeBlock(page);

  await drop(page);

  // Grayed with the reason in the tooltip, which is the repo's grammar for a
  // control that is refusing (interactions.md §4d, "Grayed, not absent"). The
  // reason names the machine (blocks.ts runOffline).
  await expect(page.locator('[data-act="run"][disabled]')).toHaveCount(1);
  await expect(page.locator('[data-act="run"][disabled]')).toHaveAttribute("title", /Not connected to/);
  await expect(page.locator('[data-act="term"][disabled]')).toHaveCount(1);

  // And the chord answers with a notice rather than doing nothing. A run is
  // sent with a `void` request and then listened for, so a run asked for at a
  // machine that is not there would open a panel reading "Running" with
  // nothing coming back to correct it (interactions.md §4d).
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("so there is nowhere to run this", { exact: false })).toBeVisible();
  expect((await page.evaluate(() => window.__harness.inlineRuns())).length).toBe(0);
});

test("the run buttons come back with the wire", async ({ page }) => {
  await writeBlock(page);
  await drop(page);
  await expect(page.locator('[data-act="run"][disabled]')).toHaveCount(1);

  await reconnect(page);

  // The connection moving is invisible to the editor's own update cycle, so
  // the control layer has to be told (blocks.ts subscribeConnections). Without
  // that subscription this passes on the way down and never comes back up.
  await expect(page.locator('[data-act="run"]:not([disabled])')).toHaveCount(1);
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-status")).toHaveText("Running");
});

test("a wire still being re-dialled does not gate anything", async ({ page }) => {
  await writeBlock(page);

  await dialling(page);

  // The reconnect ladder is a wait, not a failure, and every other verb the
  // view offers treats it as one. A request made during it is held and
  // replayed when the wire comes back (shared/transport.ts), so a block run
  // here does run, seconds late. Only "lost" gates the buttons (blocks.ts
  // linkDown), and "lost" also marks the panel unknown if the ladder runs out
  // (interactions.md §4d).
  await expect(page.locator('[data-act="run"]:not([disabled])')).toHaveCount(1);
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-status")).toHaveText("Running");

  // Now the ladder runs out. The panel stops saying the run is going and reads
  // "Disconnected".
  await drop(page);
  await expect(page.locator(".ledge-status")).toHaveText("Disconnected");
});

// The same question for the keyboard: what a panel does with characters typed
// at it while the wire is down. `inlineInput` is a `void` request (boot.tsx)
// whose rejection nothing reads. A panel that kept accepting after
// "Disconnected" would drop every character without a word (inlineTerm.ts
// accepts). The caret below the header would go on blinking meanwhile, so the
// panel looks like it is taking a password when it is not.
test("a panel whose machine is gone stops taking what is typed at it", async ({ page }) => {
  const id = await talkingRun(page);
  await page.keyboard.type("before");
  await expect.poll(() => typedAt(page, id)).toBeGreaterThan(0);
  const before = await typedAt(page, id);

  await drop(page);
  await expect(page.locator(".ledge-status")).toHaveText("Disconnected");

  await page.keyboard.type("hunter2");
  expect(await typedAt(page, id)).toBe(before);
  // Focus stays in the panel. The outage is often over in seconds, and moving
  // the caret back into the prose mid-sentence would be worse than the wait.
  // So the hint in the header changes instead (inlineTerm.ts setFocusHint).
  expect(await page.evaluate(() => !!document.activeElement?.closest(".xterm"))).toBe(true);
  await expect(page.locator(".ledge-focus-hint")).toHaveText("not connected");
});

// This panel is unreachable, not frozen. It takes typing again when the wire
// comes back. A frozen one never does.
test("a panel takes what is typed at it again when the wire comes back", async ({ page }) => {
  const id = await talkingRun(page);
  // The fake server still has this run, which is the case under test. A run
  // the server no longer has is closed out on reconnect and its panel freezes,
  // which refuses typing for the other reason.
  await page.evaluate((runId) => window.__harness.holdRuns([runId]), id);
  await drop(page);
  await page.keyboard.type("lost");
  const before = await typedAt(page, id);

  await reconnect(page);
  // Still this client's run. runningRunIds names "unknown" runs too
  // (blocks.ts), so the claim covered this one and the server did not
  // interrupt it.
  await expect(page.locator(".ledge-status")).toHaveText("Running");

  await page.keyboard.type("hunter2");
  await expect.poll(() => typedAt(page, id)).toBeGreaterThan(before);
  await expect(page.locator(".ledge-focus-hint")).toHaveText("typing here");
});
