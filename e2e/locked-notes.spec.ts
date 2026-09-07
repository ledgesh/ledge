// Note locking in the harness (locking.md §9 lists the e2e cases). The harness
// seeds a locked note ("Codebook", passphrase "letmein", vault locked at boot,
// in harness.tsx) whose body carries a needle no surface may show while the
// vault is locked. These specs cover the view half, which unit tests cannot
// reach. vault.test.ts covers the crypto; notes.fs.test.ts covers the seams.
import { expect, test } from "@playwright/test";

const NEEDLE = "vaulted needle body";

// Both helpers below act on the seeded locked note, which is titled "Codebook".
async function openBankCodes(page: import("@playwright/test").Page) {
  await page.goto("/harness.html");
  const row = page.locator('[data-target-kind="note"]', { hasText: "Codebook" });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('[data-testid="locked-face"]')).toBeVisible();
}

async function unlockBankCodes(page: import("@playwright/test").Page) {
  await page.locator('[data-testid="locked-face-unlock"]').click();
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
  await page.keyboard.type("letmein");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="vault-dialog"]')).toHaveCount(0);
  await expect(page.locator(".cm-line", { hasText: NEEDLE })).toBeVisible();
}

test("a locked note opens as a placeholder — the body is nowhere in the DOM", async ({ page }) => {
  await openBankCodes(page);
  // The row shows the lock glyph, and the tab shows the face, not an editor.
  await expect(page.locator('[data-testid="note-locked-glyph"]')).toBeVisible();
  await expect(page.getByText(NEEDLE)).toHaveCount(0);
});

test("unlock is interposed: wrong passphrase shakes and stays, right one pours the body", async ({ page }) => {
  await openBankCodes(page);
  await page.locator('[data-testid="locked-face-unlock"]').click();
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
  await page.keyboard.type("not-it");
  await page.keyboard.press("Enter");
  // The dialog stays open, says "Wrong passphrase.", and clears the field, so
  // the retry below can type the right one without clearing anything.
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
  await expect(page.getByText("Wrong passphrase.")).toBeVisible();
  await page.keyboard.type("letmein");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="vault-dialog"]')).toHaveCount(0);
  await expect(page.locator(".cm-line", { hasText: NEEDLE })).toBeVisible();
});

test("⌘L relocks: the open tab swaps back to the placeholder and the body is evicted", async ({ page }) => {
  await openBankCodes(page);
  await unlockBankCodes(page);
  await page.keyboard.press("Meta+l");
  await expect(page.locator('[data-testid="locked-face"]')).toBeVisible();
  await expect(page.getByText(NEEDLE)).toHaveCount(0);
  // ⌘L dropped the key, so opening the note again asks for the passphrase.
  await page.locator('[data-testid="locked-face-unlock"]').click();
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
});

test("search never reads locked bodies, and the footer says what was skipped", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Alt+Meta+p");
  await page.keyboard.type("needle");
  // The searched workspace's only "needle" sits in the locked body, so there
  // are no hits. The footer counts the skipped note where the answer would
  // have been (locking.md §7).
  await expect(page.locator('[data-testid="search-locked-skipped"]')).toHaveText("1 locked note not searched");
  await expect(page.getByText(NEEDLE)).toHaveCount(0);
});

test("a prompt fence in a locked note grays its run buttons with the reason; the chord surfaces the notice", async ({ page }) => {
  await openBankCodes(page);
  await unlockBankCodes(page);
  // The note carries one prompt fence and one sh fence. Both render a
  // run/term pair, but the prompt fence's pair is disabled and carries the
  // reason as its tooltip (the busy-button grammar, locking.md §7). The sh
  // block's pair stays live.
  await expect(page.locator('[data-act="run"]')).toHaveCount(2);
  await expect(page.locator('[data-act="run"][disabled]')).toHaveCount(1);
  await expect(page.locator('[data-act="term"][disabled]')).toHaveCount(1);
  await expect(page.locator('[data-act="run"]:not([disabled])')).toHaveCount(1);
  await expect(page.locator('[data-act="run"][disabled]')).toHaveAttribute(
    "title",
    /Prompt blocks can't be run in locked notes/,
  );
  // ⌘↩ with the caret in the prompt fence shows that same sentence in the
  // notice strip instead of running (locking.md §7).
  await page.locator(".cm-line", { hasText: "summarize this note" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("Prompt blocks can't be run in locked notes", { exact: false })).toBeVisible();
});

test("the palette shows exactly one lock face per note", async ({ page }) => {
  await openBankCodes(page);
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("lock");
  await expect(page.getByText("Remove Lock…")).toBeVisible();
  await expect(page.getByText("Lock This Note…")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // An ordinary note shows the other face.
  await page.locator('[data-target-kind="note"]', { hasText: "Alpha" }).click();
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("lock");
  await expect(page.getByText("Lock This Note…")).toBeVisible();
  await expect(page.getByText("Remove Lock…")).toHaveCount(0);
});

test("lock a note, then remove the lock: round trip through setup-free unlock and the confirm", async ({ page }) => {
  await page.goto("/harness.html");
  const alpha = page.locator('[data-target-kind="note"]', { hasText: "Alpha" });
  await expect(alpha).toBeVisible();
  await alpha.click();
  await expect(page.locator(".cm-line", { hasText: "alpha body" })).toBeVisible();
  // Lock This Note… with the vault locked: the unlock dialog interposes,
  // then the lock follows through without re-running the command.
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("lock");
  await page.getByText("Lock This Note…").click();
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
  await page.keyboard.type("letmein");
  await page.keyboard.press("Enter");
  // Alpha is locked now, and its row shows the open lock, since the interposed
  // unlock left the vault unlocked. The editor shows the note's new "locked:"
  // marker in the frontmatter.
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toHaveCount(2); // Codebook + Alpha
  await expect(page.locator(".cm-line", { hasText: "locked: harness-v1" }).first()).toBeVisible();
  // Remove Lock… asks once, with the exposure sentence, and then the note is
  // plain text again.
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("lock");
  await page.getByText("Remove Lock…").click();
  await expect(page.getByText("decrypted back to plain text", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Remove Lock" }).click();
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toHaveCount(1); // Codebook only
});

test("the row menu carries the lock faces, and the glyph tracks the vault", async ({ page }) => {
  await page.goto("/harness.html");
  const alpha = page.locator('[data-target-kind="note"]', { hasText: "Alpha" });
  await expect(alpha).toBeVisible();
  // A plain row offers Lock This Note…, never the locked faces.
  await alpha.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Lock This Note…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove Lock…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A locked row while the vault is shut offers Unlock Notes… and Remove
  // Lock…, and never Lock This Note….
  const codebook = page.locator('[data-target-kind="note"]', { hasText: "Codebook" });
  await codebook.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unlock Notes…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove Lock…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Lock This Note…" })).toHaveCount(0);
  // Unlock from the row: the closed lock opens, without opening the note.
  await page.getByRole("menuitem", { name: "Unlock Notes…" }).click();
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
  await page.keyboard.type("letmein");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="note-locked-glyph"]')).toHaveCount(0);
  // The same row's menu now offers Lock Notes instead, and clicking it swaps
  // the row back to the closed lock.
  await codebook.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unlock Notes…" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Lock Notes" }).click();
  await expect(page.locator('[data-testid="note-locked-glyph"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toHaveCount(0);
});

test("Lock This Note… from the row menu locks that row, not the focused note", async ({ page }) => {
  await page.goto("/harness.html");
  // Open Alpha so a different note is the focused one, then act on Beta's row.
  const alpha = page.locator('[data-target-kind="note"]', { hasText: "Alpha" });
  await expect(alpha).toBeVisible();
  await alpha.click();
  await expect(page.locator(".cm-line", { hasText: "alpha body" })).toBeVisible();
  await page.locator('[data-target-kind="note"]', { hasText: "Beta" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Lock This Note…" }).click();
  // The vault is shut, so the unlock interposes and the lock follows through.
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
  await page.keyboard.type("letmein");
  await page.keyboard.press("Enter");
  // Beta joins Codebook, both showing the open lock since the vault is now
  // unlocked. Alpha, the focused note, was never touched.
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toHaveCount(2);
  await expect(page.locator(".cm-line", { hasText: "alpha body" })).toBeVisible();
});
