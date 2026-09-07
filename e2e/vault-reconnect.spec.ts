// What a reconnect does to a vault that moved while the wire was down
// (locking.md §3, remote.md §7).
//
// The server holds the key and relocks the vault after fifteen idle minutes.
// Idleness is note-RPC traffic (bun/vault.ts touchVault), so the timer runs
// out during an outage and the `vaultChanged` push announcing the relock is
// dropped rather than queued (remote.md §7). The client asks again on
// reconnect: the answer goes into the mirrored state (vault/channel.ts), and
// editorPool evicts decrypted buffers off that mirror
// (workspace/editorPool.ts). A client that never asks keeps a locked note's
// plaintext on screen until the tab closes.
//
// `__harness.vaultMoved` moves the server's vault state with nobody
// listening. `__harness.linkState` brings the wire back.
import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

// The needle in the seeded locked note's body (harness.tsx), which no surface
// may show while the vault is shut.
const NEEDLE = "vaulted needle body";

async function reconnect(page: Page) {
  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await page.evaluate(() => window.__harness.linkState("live", ""));
}

async function openCodebook(page: Page) {
  await page.goto("/harness.html");
  const row = page.locator('[data-target-kind="note"]', { hasText: "Codebook" });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('[data-testid="locked-face"]')).toBeVisible();
}

async function unlock(page: Page) {
  await page.locator('[data-testid="locked-face-unlock"]').click();
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
  await page.keyboard.type("letmein");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="vault-dialog"]')).toHaveCount(0);
  await expect(page.locator(".cm-line", { hasText: NEEDLE })).toBeVisible();
}

// The common case: walking away lets the vault go idle until it relocks, and
// taking the laptop along drops the wire.
test("a relock that happened while the wire was down evicts the body on reconnect", async ({ page }) => {
  await openCodebook(page);
  await unlock(page);

  await page.evaluate(() => window.__harness.vaultMoved("locked"));
  await reconnect(page);

  // The tab is back at the placeholder, with the plaintext out of the DOM
  // rather than covered. The eviction destroys the view (editorPool
  // evictToHeldFace), because replacing the doc instead would leave the
  // plaintext in the undo history for Cmd+Z.
  await expect(page.locator('[data-testid="locked-face"]')).toBeVisible();
  await expect(page.getByText(NEEDLE)).toHaveCount(0);
  // And the row says so too, from the same mirrored state.
  await expect(page.locator('[data-testid="note-locked-glyph"]')).toBeVisible();
});

// Now the same case in reverse: another device unlocked the vault while this
// client was away. The client re-asks `vaultState` and takes whatever answer
// comes back, so a reconnect is a refresh and not a relock check. The body
// fills in through the same subscription: editorPool reloads every held face
// when the state arrives unlocked.
test("an unlock that happened while the wire was down fills the held face in", async ({ page }) => {
  await openCodebook(page);

  await page.evaluate(() => window.__harness.vaultMoved("unlocked"));
  await reconnect(page);

  await expect(page.locator(".cm-line", { hasText: NEEDLE })).toBeVisible();
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toBeVisible();
});

// A reconnect on its own is not a reason to evict. Evicting on every wire
// event would drop the open note back to the placeholder after any brief
// outage, including notes the vault never relocked.
test("a reconnect with the vault where it was leaves the open note alone", async ({ page }) => {
  await openCodebook(page);
  await unlock(page);

  await reconnect(page);

  await expect(page.locator(".cm-line", { hasText: NEEDLE })).toBeVisible();
  await expect(page.locator('[data-testid="locked-face"]')).toHaveCount(0);
});
