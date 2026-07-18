// Daily notes and templates, the view's share: ⌘J create-or-opens today's
// note (idempotently — a second press focuses the live tab, no twin note),
// and ⌥⌘N opens the command palette pre-filtered to the template entries —
// the notes whose frontmatter declares `template: true`, read LIVE from the
// note lists, so marking a note surfaces its entry without any relaunch.
// With no template anywhere, ⌥⌘N lands on New Template instead:
// the empty state is the tutorial. The Bun half — local-date titling,
// template resolution, the daily knobs — is daily.fs.test.ts's subject; the
// harness fake mirrors it over the shared template module, so what the
// specs see is the same instantiation.
import { expect, test, type Page } from "@playwright/test";

const SCRATCH = "/harness/scratch";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const tab = (page: Page, title: string) => page.locator("[data-tab]", { hasText: title });

// The harness runs on this machine's clock, so the spec computes the same
// local YYYY-MM-DD the fake store will.
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("⌘J creates today's note and lands in its tab", async ({ page }) => {
  await page.keyboard.press("Meta+j");
  await expect(tab(page, today())).toBeVisible();
  // The note really exists in the store, dated and titled.
  const text = await page.evaluate(
    (r) => {
      const note = window.__harness.store.list(r).find((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.title));
      return note ? window.__harness.store.readNote(note.path) : null;
    },
    SCRATCH,
  );
  expect(text).toBe(`# ${today()}\n`);
});

test("a second ⌘J the same day focuses the tab — one note, no twin", async ({ page }) => {
  await page.keyboard.press("Meta+j");
  await expect(tab(page, today())).toBeVisible();
  await page.keyboard.press("Meta+j");
  await expect(tab(page, today())).toHaveCount(1);
  const dated = await page.evaluate(
    (r) => window.__harness.store.list(r).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.title)).length,
    SCRATCH,
  );
  expect(dated).toBe(1);
});

test("⌘J instantiates the note marked template: daily — a corpus fact, no settings, no restart", async ({ page }) => {
  await page.evaluate((r) => {
    window.__harness.store.seed(r, "---\ntemplate: daily\n---\n# Daily Skeleton\n\nCarry over [[{{yesterday}}]].\n");
    window.__harness.notesChanged(r);
  }, SCRATCH);
  await expect(noteRow(page, "Daily Skeleton")).toBeVisible();
  // The daily role's own glyph, distinct from the generic template's.
  await expect(noteRow(page, "Daily Skeleton").locator("svg.lucide-calendar-days")).toBeVisible();
  await page.keyboard.press("Meta+j");
  await expect(tab(page, today())).toBeVisible();
  const text = await page.evaluate(
    (r) => {
      const note = window.__harness.store.list(r).find((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.title));
      return note ? window.__harness.store.readNote(note.path) : null;
    },
    SCRATCH,
  );
  expect(text).toContain(`# ${today()}`);
  expect(text).toContain("Carry over [[");
  // The role stays with the template — today's note must not claim it.
  expect(text).not.toContain("template:");
});

test("a note marked template: true joins the ⌥⌘N picker live; Enter instantiates it", async ({ page }) => {
  // No template exists at boot. Marking one is just a note gaining the
  // frontmatter line — seeded here like an external write, with the watcher
  // push a real save would trigger (a boot-time seed would shift the older
  // specs' counts). No relaunch, no settings: the entry must simply appear.
  await page.evaluate((r) => {
    window.__harness.store.seed(r, "---\ntemplate: true\n---\n# Meeting\n\nAgenda for {{date}}.\n");
    window.__harness.notesChanged(r);
  }, SCRATCH);
  await expect(noteRow(page, "Meeting")).toBeVisible();
  // The marker shows where notes are listed: the sidebar row wears the
  // template glyph, a plain note keeps the file glyph — and the ⌘P picker
  // rows agree with the sidebar.
  await expect(noteRow(page, "Meeting").locator("svg.lucide-layout-template")).toBeVisible();
  await expect(noteRow(page, "Alpha").locator("svg.lucide-file-text")).toBeVisible();
  await expect(noteRow(page, "Alpha").locator("svg.lucide-layout-template")).toHaveCount(0);
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("Meeting");
  await expect(page.locator("[data-active] svg.lucide-layout-template")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+Meta+n");
  // The palette opened pre-filtered: the template entry is the highlighted row.
  await expect(page.locator("[data-active]")).toContainText("New Note from Template: Meeting");
  await page.keyboard.press("Enter");
  // The pick created an "Untitled" note from the template, substituted — and
  // the marker stayed with the template: the instance is not a template.
  await expect(tab(page, "Untitled")).toBeVisible();
  const text = await page.evaluate(
    (r) => {
      const note = window.__harness.store.list(r).find((n) => n.title === "Untitled");
      return note ? window.__harness.store.readNote(note.path) : null;
    },
    SCRATCH,
  );
  expect(text).toContain("# Untitled");
  expect(text).toContain(`Agenda for ${today()}.`);
  expect(text).not.toContain("template: true");
});

test("selecting New Note from Template… INSIDE the palette re-seeds it (no silent no-op)", async ({ page }) => {
  // The chord-less route — ⇧⌘P, find the command, Enter — is how anyone
  // discovers the feature, and it re-opens the overlay from within itself:
  // without the keyed remount the old filter text stayed on screen and the
  // exec looked like it did nothing.
  await page.evaluate((r) => {
    window.__harness.store.seed(r, "---\ntemplate: true\n---\n# Meeting\n\nAgenda.\n");
    window.__harness.notesChanged(r);
  }, SCRATCH);
  await expect(noteRow(page, "Meeting")).toBeVisible();
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("from template");
  // The generated per-template entry may outrank the parent command in the
  // fuzzy order — click the parent row itself: this spec is about what
  // running the PARENT from inside the palette does.
  await page.getByText("New Note from Template…").click();
  // The palette is still up, now re-seeded to the picker: the typed filter is
  // gone and the template entry is the highlighted row.
  await expect(page.locator("input")).toHaveValue("New Note from Template: ");
  await expect(page.locator("[data-active]")).toContainText("New Note from Template: Meeting");
  await page.keyboard.press("Enter");
  await expect(tab(page, "Untitled")).toBeVisible();
});

test("the same in-palette selection with no templates lands on the starter entry", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("from template");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-active]")).toContainText("New Template");
});

test("New Daily Template creates the pre-marked starter; the face flips to Edit; ⌘J instantiates it", async ({ page }) => {
  // No claimant yet: only the New face is offered ("Edit Daily Template"
  // would promise a note that does not exist).
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("daily template");
  await expect(page.getByText("Edit Daily Template")).toHaveCount(0);
  await page.getByText("New Daily Template").click();
  await expect(tab(page, "Daily Template")).toBeVisible();
  const text = await page.evaluate(
    (r) => {
      const n = window.__harness.store.list(r).find((x) => x.title === "Daily Template");
      return n ? window.__harness.store.readNote(n.path) : null;
    },
    SCRATCH,
  );
  // Born holding the role, with the carry-over line spelled as tokens.
  expect(text).toContain("template: daily");
  expect(text).toContain("Continued from [[{{yesterday}}]].");
  // After the watcher push a real save would trigger, the sidebar row wears
  // ⌘J's own CalendarDays — not the generic template glyph.
  await page.evaluate((r) => window.__harness.notesChanged(r), SCRATCH);
  await expect(noteRow(page, "Daily Template").locator("svg.lucide-calendar-days")).toBeVisible();
  await expect(noteRow(page, "Daily Template").locator("svg.lucide-layout-template")).toHaveCount(0);
  // The verb's face flips: the role exists now, so the palette offers Edit —
  // and it must OPEN the claimant, not merely focus a tab that happens to be
  // up: close the tab first so the open is real.
  await page.keyboard.press("Meta+w");
  await expect(tab(page, "Daily Template")).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("daily template");
  await expect(page.getByText("New Daily Template")).toHaveCount(0);
  await page.getByText("Edit Daily Template").click();
  await expect(tab(page, "Daily Template")).toBeVisible();
  // And ⌘J instantiates the starter it just created, marker stripped.
  await page.keyboard.press("Meta+j");
  await expect(tab(page, today())).toBeVisible();
  const day = await page.evaluate(
    (r) => {
      const n = window.__harness.store.list(r).find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.title));
      return n ? window.__harness.store.readNote(n.path) : null;
    },
    SCRATCH,
  );
  expect(day).toContain("Continued from [[");
  expect(day).not.toContain("template:");
});

test('a "daily" query ranks ⌘J\'s Open Today\'s Daily Note first — the chord is the frequency claim', async ({ page }) => {
  // With a claimant and a plain template around, the unchorded verbs' titles
  // match "daily" earlier in the string; CHORD_BOOST must still put the
  // everyday act on top, with the once-in-a-while verbs beneath it.
  await page.evaluate((r) => {
    window.__harness.store.seed(r, "---\ntemplate: daily\n---\n# Daily Skeleton\n\nbody\n");
    window.__harness.store.seed(r, "---\ntemplate: true\n---\n# Daily 1\n\nbody\n");
    window.__harness.notesChanged(r);
  }, SCRATCH);
  await expect(noteRow(page, "Daily Skeleton")).toBeVisible();
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("daily");
  await expect(page.locator("[data-active]")).toContainText("Open Today's Daily Note");
  // The rest still rank by match quality: Edit Daily Template before the
  // generated per-template rows.
  await expect(page.getByText("Edit Daily Template")).toBeVisible();
});

test("⌥⌘N with no templates lands on New Template; Enter creates it marked", async ({ page }) => {
  await page.keyboard.press("Alt+Meta+n");
  await expect(page.locator("[data-active]")).toContainText("New Template");
  await page.keyboard.press("Enter");
  // The starter opens for editing, and it is born a template — the picker it
  // teaches about will offer it.
  await expect(tab(page, "Untitled Template")).toBeVisible();
  const text = await page.evaluate(
    (r) => {
      const note = window.__harness.store.list(r).find((n) => n.title === "Untitled Template");
      return note ? window.__harness.store.readNote(note.path) : null;
    },
    SCRATCH,
  );
  expect(text).toContain("template: true");
  expect(text).toContain("{{date}}");
});
