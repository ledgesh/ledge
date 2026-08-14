// What a reconnect does to the note store (notes/channel.ts onNotesRelink,
// remote.md §7).
//
// `notesChanged` is the watcher's push: one root's files moved behind the app's
// back. A push with nowhere to go is dropped rather than queued
// (bun/daemon.ts), so everything that moved while the wire was down went
// unannounced and nothing re-sends it afterwards. The lists and every open
// buffer go on showing what was true when the wire went, and no later push says
// otherwise: the next `notesChanged` names the next change, never the backlog.
//
// A Mac has a belt for this in window focus, which runs the same refresh. It is
// no help where this matters most. Watching the bar say "reconnecting…" never
// leaves the window, so no focus event fires when the wire returns, and a phone
// has no such event to wait for at all (ios.md §5) while being the client whose
// wire drops constantly.
//
// The sibling of inline-reconnect, terminal-reconnect and vault-reconnect. The
// external write itself is external-edits.spec.ts's seam
// (`store.writeExternal`, the "agent in the drawer"); what is new here is that
// nothing announces it and the reconnect has to.
import { expect, test, type Page } from "@playwright/test";

const SCRATCH = "/harness/scratch";
const ALPHA = `${SCRATCH}/alpha.md`;

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// A write nothing tells the app about: the other device's save, a git checkout,
// an agent working in a drawer. Deliberately NOT followed by
// __harness.notesChanged — the whole premise is the push that never came.
const wroteWhileAway = (page: Page, path: string, text: string) =>
  page.evaluate(([p, t]) => window.__harness.store.writeExternal(p, t), [path, text] as const);

async function reconnect(page: Page) {
  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await page.evaluate(() => window.__harness.linkState("live", ""));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await noteRow(page, "Alpha").click();
  await expect(page.locator(".cm-content")).toContainText("alpha body");
});

// The open buffer, which is the half a user is looking at.
test("a note rewritten while the wire was down pours into the open editor on reconnect", async ({ page }) => {
  await wroteWhileAway(page, ALPHA, "# Alpha\n\nthe version from the other device\n");

  await reconnect(page);

  await expect(page.locator(".cm-content")).toContainText("the version from the other device");
});

// And the lists, which is the other half and a separate mechanism: the editor
// follows through reloadOpenNotes, the sidebar through refreshFolder. A note
// that appeared while the wire was down has no open tab to follow.
test("a note that appeared while the wire was down joins the list on reconnect", async ({ page }) => {
  await wroteWhileAway(page, `${SCRATCH}/newcomer.md`, "# Newcomer\n\nwritten on the other machine\n");
  await expect(noteRow(page, "Newcomer")).toHaveCount(0);

  await reconnect(page);

  await expect(noteRow(page, "Newcomer")).toBeVisible();
});

// The claim the design rests on: the tags and backlinks panels carry no
// reconnect subscription of their own, because they re-fetch when the store's
// note list for their folder changes and the refresh is what changes it. If
// that ever stops being true, this fails rather than the panels quietly going
// stale on every phone reconnect.
test("the tags panel follows the refresh, with no subscription of its own", async ({ page }) => {
  await page.keyboard.press("Alt+Meta+t");
  await expect(page.locator("aside", { hasText: "Tags" })).toBeVisible();

  await wroteWhileAway(page, `${SCRATCH}/tagged-elsewhere.md`, "# Tagged Elsewhere\n\nfiled under #shipped\n");
  await expect(page.locator('[data-target-kind="tag"]', { hasText: "shipped" })).toHaveCount(0);

  await reconnect(page);

  await expect(page.locator('[data-target-kind="tag"]', { hasText: "shipped" })).toBeVisible();
});

// A reconnect must not cost anyone what they typed. The refresh reloads CLEAN
// buffers only (editorPool reloadCandidates), and reusing that one refresh is
// what keeps the guard: a reconnect wired to a blunter reload would clobber the
// buffer here, and on a phone it would do it every time the wire blinked.
test("a reconnect does not clobber a buffer that was being edited", async ({ page }) => {
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus my half-typed thought");
  await wroteWhileAway(page, ALPHA, "# Alpha\n\nthe competing version\n");

  await reconnect(page);

  await expect(page.locator(".cm-content")).toContainText("plus my half-typed thought");
  await expect(page.locator(".cm-content")).not.toContainText("the competing version");
});
