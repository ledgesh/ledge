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

// --- a buffer stranded across an outage --------------------------------------
//
// The case above is a wire that flapped: the ladder held the writes and landed
// them, so the buffer was never at risk and taking it away would be the clobber.
// This is the other one. The ladder ran out, saving was suspended under the
// buffer (notes/store.ts holdSaves), and by the time the server is reachable
// again its copy has moved on — because somebody's phone was editing the same
// note from the airport.
//
// The winner flips here, and the reason it flips is that the argument for the
// buffer winning is that its author is at the keyboard. After an outage the
// version with an author present is more likely the other one. Neither is
// destroyed either way: the losing text goes to the trash, and restoring it
// lands it BESIDE the live note so the merge stays the user's to make.

async function outage(page: Page) {
  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await page.evaluate(() => window.__harness.linkState("lost", "Lost the connection: host is down."));
}

const unsavedDot = (page: Page) => page.locator("[data-unsaved]");

test("a buffer typed during an outage loses to the server's newer version, and is kept", async ({ page }) => {
  const before = await page.evaluate((root) => window.__harness.store.listTrash(root).length, SCRATCH);

  await outage(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus what I typed on the plane");
  // Nothing reached the server while it could not be reached.
  await expect(unsavedDot(page)).toHaveAttribute("data-unsaved", "stranded");

  // Meanwhile, the other device.
  await wroteWhileAway(page, ALPHA, "# Alpha\n\nthe version from the phone\n");
  await page.evaluate(() => window.__harness.linkState("live", ""));

  await expect(page.locator(".cm-content")).toContainText("the version from the phone");
  await expect(page.locator(".cm-content")).not.toContainText("what I typed on the plane");
  await expect
    .poll(() => page.evaluate((root) => window.__harness.store.listTrash(root).length, SCRATCH))
    .toBe(before + 1);
});

test("the losing version is announced rather than only logged", async ({ page }) => {
  await outage(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus what I typed on the plane");
  await wroteWhileAway(page, ALPHA, "# Alpha\n\nthe version from the phone\n");

  await page.evaluate(() => window.__harness.linkState("live", ""));

  await expect(page.getByText(/“Alpha” changed on the server while you were disconnected/)).toBeVisible();
  await expect(page.getByText(/what you had typed is in the Trash/)).toBeVisible();
});

// The ordinary outage, where nobody else touched the note. Nothing is displaced
// and nothing is said: the buffer simply gets written once there is somewhere
// to write it.
test("a buffer stranded against a note nobody else touched is just saved on reconnect", async ({ page }) => {
  await outage(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus what I typed on the plane");

  await page.evaluate(() => window.__harness.linkState("live", ""));

  await expect(page.locator(".cm-content")).toContainText("what I typed on the plane");
  await expect(unsavedDot(page)).toHaveCount(0);
  await expect(page.getByText(/changed on the server/)).toHaveCount(0);
});

// The indicator itself, which the app had none of in any state before this.
test("an unsaved note says so on its tab, and says more when the wire is down", async ({ page }) => {
  await expect(unsavedDot(page)).toHaveCount(0);

  await outage(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed with nowhere to put it");
  await expect(unsavedDot(page)).toHaveAttribute("data-unsaved", "stranded");
  await expect(unsavedDot(page)).toHaveAttribute("title", /server cannot be reached/);

  await page.evaluate(() => window.__harness.linkState("live", ""));
  await expect(unsavedDot(page)).toHaveCount(0);
});
