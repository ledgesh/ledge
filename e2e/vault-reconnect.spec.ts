// What a reconnect does to a vault that moved while the wire was down
// (locking.md §3, remote.md §7).
//
// The vault is the SERVER's: it holds the key, and it relocks itself after
// fifteen idle minutes. That relock is announced with a `vaultChanged` push,
// and a push with nowhere to go is dropped rather than queued (bun/daemon.ts).
// Idleness is measured in note-RPC traffic (bun/vault.ts touchVault), so a
// client whose wire is down is exactly the one the timer fires behind: it is
// the likeliest reader of that push and the one certain to miss it. Coming back
// is therefore when it asks.
//
// What hangs on the answer is not a glyph. The mirrored state is what evicts
// decrypted buffers (workspace/editorPool.ts), so a client that never asks goes
// on showing a locked note's plaintext for as long as the tab stays open.
//
// The sibling of inline-reconnect.spec.ts and terminal-reconnect.spec.ts, which
// do the same for run panels and for the drawer. `__harness.vaultMoved` is the
// server changing its mind with nobody listening; `__harness.linkState` is the
// wire coming back.
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

// The whole point of the fix. Walking away is what relocks the vault, and
// walking away with a laptop is also what drops the wire, so the two arrive
// together far more often than either arrives alone.
test("a relock that happened while the wire was down evicts the body on reconnect", async ({ page }) => {
  await openCodebook(page);
  await unlock(page);

  await page.evaluate(() => window.__harness.vaultMoved("locked"));
  await reconnect(page);

  // Back to the placeholder, and the plaintext is out of the DOM rather than
  // merely covered: the eviction destroys the view (editorPool), because a
  // relock that Cmd+Z could reverse would not be one.
  await expect(page.locator('[data-testid="locked-face"]')).toBeVisible();
  await expect(page.getByText(NEEDLE)).toHaveCount(0);
  // And the row says so too, from the same mirrored state.
  await expect(page.locator('[data-testid="note-locked-glyph"]')).toBeVisible();
});

// The other direction, and what makes this a refresh rather than a
// relock-shaped special case: a vault another device opened while this one was
// unreachable pours the body in, through the same subscription (editorPool
// reloads every held face when the state arrives unlocked).
test("an unlock that happened while the wire was down fills the held face in", async ({ page }) => {
  await openCodebook(page);

  await page.evaluate(() => window.__harness.vaultMoved("unlocked"));
  await reconnect(page);

  await expect(page.locator(".cm-line", { hasText: NEEDLE })).toBeVisible();
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toBeVisible();
});

// A reconnect is not a reason to throw the note away. Evicting on every wire
// event would be the cheap way to be safe and the wrong one: a train tunnel
// would close the note somebody was reading, and it would do it to notes the
// vault never stopped holding the key for.
test("a reconnect with the vault where it was leaves the open note alone", async ({ page }) => {
  await openCodebook(page);
  await unlock(page);

  await reconnect(page);

  await expect(page.locator(".cm-line", { hasText: NEEDLE })).toBeVisible();
  await expect(page.locator('[data-testid="locked-face"]')).toHaveCount(0);
});
