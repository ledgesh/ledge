// What a reconnect does to a panel that was left on "Running".
//
// The wire dropping does not pause anything: the run keeps going on the server
// and its events are pushed at a connection that is gone, and a push with
// nowhere to go is dropped rather than queued (bun/daemon.ts). So a client that
// comes back can be holding a panel for a run that finished while it was away,
// with a run button disabled for good behind it. Coming back is therefore also
// when it asks (bridge.ts reconcileRuns), and these state both answers.
//
// And what the outage ITSELF does to one, which is the other half: a panel is
// the only thing on screen that claims a machine is doing something right now,
// so it is the one piece of chrome that can be caught lying. While the wire is
// down it says so, and it neither invents an ending nor lets the block start a
// second run over the top of a first that may still be going.
//
// PTYs are inert here; `__harness.holdRuns` is the fake server's side of that
// question and `__harness.linkState` is the wire going and coming back.
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

// That block, run inline.
async function runBlock(page: import("@playwright/test").Page) {
  await writeBlock(page);
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-status")).toHaveText("Running");
  const runs = await page.evaluate(() => window.__harness.inlineRuns());
  return runs[runs.length - 1].id;
}

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

  // Claimed by id: the panel is the only record this side has of the run.
  await expect.poll(() => page.evaluate(() => window.__harness.runClaims())).toContainEqual([id]);
  // Unconfirmed, so it ends with no status — which is honest, because what
  // happened to it happened while nobody was listening.
  await expect(page.locator(".ledge-status")).toHaveText("Session ended");
  await expect(page.locator(".ledge-dot-error")).toBeVisible();

  // And the block is runnable again. One live run per block is what disables
  // it, so a panel stuck on "Running" is a run button dead for the session.
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
  // than starting a second one nothing would ever close.
  await page.locator(".cm-line", { hasText: "sleep 30" }).click();
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(100);
  expect((await page.evaluate(() => window.__harness.inlineRuns())).length).toBe(1);
});

test("a client with no panels claims nothing", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();

  await reconnect(page);

  // The empty claim is sent rather than skipped: it is what tells a server
  // that everything it is running belongs to a page that no longer exists.
  await expect.poll(() => page.evaluate(() => window.__harness.runClaims())).toContainEqual([]);
});

test("a run whose machine goes away says so, and invents no ending", async ({ page }) => {
  await runBlock(page);

  await drop(page);

  // Not "Session ended", which is what this used to have no way to avoid
  // saying: the program may be four minutes into a deploy, and the only thing
  // this client actually knows is about the wire.
  await expect(page.locator(".ledge-status")).toHaveText("Disconnected");
  await expect(page.locator(".ledge-dot-unknown")).toBeVisible();
  // And the panel is still on screen, holding whatever had arrived. An outage
  // is not a reason to throw that away, and the panel is also the only record
  // of the run this client has left to claim with when it comes back.
  await expect(page.locator("[data-ledge-run]")).toBeVisible();
});

test("a run the server kept is picked back up where it left off", async ({ page }) => {
  const id = await runBlock(page);
  await drop(page);
  await expect(page.locator(".ledge-status")).toHaveText("Disconnected");
  await page.evaluate((runId) => window.__harness.holdRuns([runId]), id);

  await reconnect(page);

  // Claimed even though this client had stopped being sure of it — a claim
  // that named only the certain ones would have had the server interrupt
  // exactly the runs the outage made uncertain (bridge.ts runningRunIds).
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

  // Grayed with the reason on them, which is the busy-button grammar: a dead
  // button with no explanation is the same mystery as a dead one with no
  // effect, only quieter.
  await expect(page.locator('[data-act="run"][disabled]')).toHaveCount(1);
  await expect(page.locator('[data-act="run"][disabled]')).toHaveAttribute("title", /Not connected to/);
  await expect(page.locator('[data-act="term"][disabled]')).toHaveCount(1);

  // And the chord is refused out loud rather than silently, because a run is
  // the one thing here that cannot report its own failure: it is announced at
  // the server and then listened for, so a run started at a machine that is
  // not there would open a panel reading "Running" that nothing would ever
  // come back to correct.
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

  // The ladder is a wait, not a failure, and every other thing the view does
  // treats it as one: a request made here is held and replayed when the wire
  // comes back, so a block run here really does run, seconds late. Refusing it
  // would refuse something that was going to work — and if the ladder runs out
  // instead, the "lost" that ends it marks the panel unknown on the way past,
  // which is the honest ending arriving without any help from a gate.
  await expect(page.locator('[data-act="run"]:not([disabled])')).toHaveCount(1);
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".ledge-status")).toHaveText("Running");

  // And that is the ending: the ladder gives up, and the panel it left behind
  // stops claiming anything.
  await drop(page);
  await expect(page.locator(".ledge-status")).toHaveText("Disconnected");
});
