// Note locking, end to end in the harness (locking.md §9): the harness
// seeds a LOCKED note ("Codebook", passphrase "letmein", vault state locked at
// boot — harness.tsx) whose body carries a needle no surface may show while
// held. What only the harness can prove is the view half: the placeholder
// face, the interposed unlock, ⌘L's eviction, the palette's and the row
// menu's two faces, the vault-tracking row glyph (closed lock shut, open
// lock unlocked), the search footer, and the prompt fence's missing run
// affordance. The crypto itself is vault.test.ts's; the seams are
// notes.fs.test.ts's.
import { expect, test } from "@playwright/test";

const NEEDLE = "vaulted needle body";

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
  // The row wears the lock glyph; the tab shows the face, not an editor.
  await expect(page.locator('[data-testid="note-locked-glyph"]')).toBeVisible();
  await expect(page.getByText(NEEDLE)).toHaveCount(0);
});

test("unlock is interposed: wrong passphrase shakes and stays, right one pours the body", async ({ page }) => {
  await openBankCodes(page);
  await page.locator('[data-testid="locked-face-unlock"]').click();
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
  await page.keyboard.type("not-it");
  await page.keyboard.press("Enter");
  // Wrong passphrase: the dialog stays, says so, and the field cleared.
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
  // Re-opening prompts again — the unlock did not outlive the lock.
  await page.locator('[data-testid="locked-face-unlock"]').click();
  await expect(page.locator('[data-testid="vault-dialog"]')).toBeVisible();
});

test("search never reads locked bodies, and the footer says what was skipped", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Alt+Meta+p");
  await page.keyboard.type("needle");
  // The only "needle" in the attached workspace lives in the locked body:
  // no hits, and the skip is said where the answer would have been.
  await expect(page.locator('[data-testid="search-locked-skipped"]')).toHaveText("1 locked note not searched");
  await expect(page.getByText(NEEDLE)).toHaveCount(0);
});

test("a prompt fence in a locked note grays its run buttons with the reason; the chord surfaces the notice", async ({ page }) => {
  await openBankCodes(page);
  await unlockBankCodes(page);
  // The note carries one prompt fence and one sh fence: both render run/term
  // pairs, but the prompt fence's are DISABLED with the reason as tooltip
  // (the busy-button grammar) while the sh block's stay live.
  await expect(page.locator('[data-act="run"]')).toHaveCount(2);
  await expect(page.locator('[data-act="run"][disabled]')).toHaveCount(1);
  await expect(page.locator('[data-act="term"][disabled]')).toHaveCount(1);
  await expect(page.locator('[data-act="run"]:not([disabled])')).toHaveCount(1);
  await expect(page.locator('[data-act="run"][disabled]')).toHaveAttribute(
    "title",
    /Prompt blocks can't be run in locked notes/,
  );
  // The chord inside the prompt fence answers with the notice, not silence
  // (and never a run).
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
  // An ordinary note wears the other face.
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
  // The note relists locked — with the OPEN lock: the interposed unlock left
  // the vault unlocked, and the glyph tracks it. Its editor shows the marker.
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toHaveCount(2); // Codebook + Alpha
  await expect(page.locator(".cm-line", { hasText: "locked: harness-v1" }).first()).toBeVisible();
  // Remove Lock…: one confirm (the exposure sentence), then plain again.
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
  // A locked row (vault shut): Unlock Notes… + Remove Lock…, no lock face.
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
  // The same row's menu now offers the walking-away verb instead; taking it
  // closes the glyph again.
  await codebook.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unlock Notes…" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Lock Notes" }).click();
  await expect(page.locator('[data-testid="note-locked-glyph"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toHaveCount(0);
});

test("Lock This Note… from the row menu locks that row, not the focused note", async ({ page }) => {
  await page.goto("/harness.html");
  // Open Alpha so a DIFFERENT note is the focused one, then act on Beta's row.
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
  // Beta joins Codebook, both open-locked (the vault is now unlocked) —
  // and Alpha, the focused note, was never touched.
  await expect(page.locator('[data-testid="note-unlocked-glyph"]')).toHaveCount(2);
  await expect(page.locator(".cm-line", { hasText: "alpha body" })).toBeVisible();
});
