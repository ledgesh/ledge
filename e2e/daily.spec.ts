// Daily notes and templates, from the view's side. A template is a note
// whose frontmatter carries a `template` marker (`true` or `daily`). The Bun
// half is covered by daily.fs.test.ts (local-date titling, template
// resolution, the daily folder) and daily.test.ts (the daily workspace). The
// harness fake and Bun share one template module, so the bytes match.
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
  // Not just a tab: the store holds a note titled with today's date, whose
  // body is that H1 and nothing else.
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
  // The sidebar row shows the daily role's glyph, CalendarDays, rather than
  // the generic template glyph.
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
  // The role stays with the template. Today's note must not claim it.
  expect(text).not.toContain("template:");
});

test("a note marked template: true joins the ⌥⌘N picker live; Enter instantiates it", async ({ page }) => {
  // No template exists at boot. Marking one adds a frontmatter line. The
  // spec seeds that note into the store and then pushes notesChanged, the
  // harness stand-in for the refresh a real external write triggers. Seeding
  // at boot instead would shift the older specs' counts. The entry has to
  // appear with no relaunch and no setting.
  await page.evaluate((r) => {
    window.__harness.store.seed(r, "---\ntemplate: true\n---\n# Meeting\n\nAgenda for {{date}}.\n");
    window.__harness.notesChanged(r);
  }, SCRATCH);
  await expect(noteRow(page, "Meeting")).toBeVisible();
  // The marker shows up wherever notes are listed: the sidebar row gets the
  // template glyph, a plain note keeps the file glyph, and the ⌘P picker
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
  // The pick created an "Untitled" note from the template, with its tokens
  // substituted. Instantiation strips the marker from the copy, so the new
  // note is not a template; the template note keeps its own marker.
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
  // The chord-less route (⇧⌘P, find the command, Enter) is the discoverable
  // one, and it re-opens the overlay from inside itself. Without the keyed
  // remount (the overlay `seq` in App.tsx) the typed filter stays on screen
  // and running the command looks like a no-op.
  await page.evaluate((r) => {
    window.__harness.store.seed(r, "---\ntemplate: true\n---\n# Meeting\n\nAgenda.\n");
    window.__harness.notesChanged(r);
  }, SCRATCH);
  await expect(noteRow(page, "Meeting")).toBeVisible();
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("from template");
  // The generated per-template entry may outrank the parent command in the
  // fuzzy order, so the click targets the parent row itself. This spec is
  // about what running the parent from inside the palette does.
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
  // The starter is created already marked `template: daily`, and its
  // carry-over line holds the {{yesterday}} token unexpanded.
  expect(text).toContain("template: daily");
  expect(text).toContain("Continued from [[{{yesterday}}]].");
  // The spec pushes notesChanged, the harness stand-in for the refresh a
  // real create triggers. The sidebar row then shows ⌘J's own CalendarDays
  // glyph, not the generic template one.
  await page.evaluate((r) => window.__harness.notesChanged(r), SCRATCH);
  await expect(noteRow(page, "Daily Template").locator("svg.lucide-calendar-days")).toBeVisible();
  await expect(noteRow(page, "Daily Template").locator("svg.lucide-layout-template")).toHaveCount(0);
  // A template claims the daily role now, so the palette entry reads Edit
  // rather than New. Edit has to open the claimant, not just focus a tab
  // that happens to be up, so the tab is closed first.
  await page.keyboard.press("Meta+w");
  await expect(tab(page, "Daily Template")).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("daily template");
  await expect(page.getByText("New Daily Template")).toHaveCount(0);
  await page.getByText("Edit Daily Template").click();
  await expect(tab(page, "Daily Template")).toBeVisible();
  // ⌘J instantiates the starter created above, and the day's note comes out
  // with the marker stripped.
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
  // The seeds give the query two rivals: a claimant, so Edit Daily Template
  // shows, and a plain template, so a generated row shows. Edit Daily
  // Template puts "Daily" nearer the start of its title, which scores better
  // on its own. CHORD_BOOST (notes/fuzzy.ts) must still rank the chorded
  // Open Today's Daily Note first.
  await page.evaluate((r) => {
    window.__harness.store.seed(r, "---\ntemplate: daily\n---\n# Daily Skeleton\n\nbody\n");
    window.__harness.store.seed(r, "---\ntemplate: true\n---\n# Daily 1\n\nbody\n");
    window.__harness.notesChanged(r);
  }, SCRATCH);
  await expect(noteRow(page, "Daily Skeleton")).toBeVisible();
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("daily");
  await expect(page.locator("[data-active]")).toContainText("Open Today's Daily Note");
  // The boost lifts the chorded verb without dropping the rest: Edit Daily
  // Template is still on the list.
  await expect(page.getByText("Edit Daily Template")).toBeVisible();
});

test("⌥⌘N with no templates lands on New Template; Enter creates it marked", async ({ page }) => {
  await page.keyboard.press("Alt+Meta+n");
  await expect(page.locator("[data-active]")).toContainText("New Template");
  await page.keyboard.press("Enter");
  // The starter opens for editing. It is already marked `template: true`,
  // so it shows up in the picker its own body describes.
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
