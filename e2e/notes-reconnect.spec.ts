// What a reconnect does to the note store (notes/channel.ts onNotesRelink,
// remote.md §7).
//
// `notesChanged` is the watcher's push: one root's files moved behind the
// app's back. A push with nowhere to go is dropped rather than queued
// (bun/audience.ts), and nothing re-sends it. So the lists and every open
// buffer keep showing what was true when the wire went, and the next
// `notesChanged` names the next change, not the backlog.
//
// Window focus runs the same refresh on a Mac, and it misses these cases.
// Watching the bar say "reconnecting…" never leaves the window, so no focus
// event fires when the wire returns. A phone has no focus event at all
// (ios.md §5), and its wire drops most often.
//
// The sibling of inline-reconnect.spec.ts, terminal-reconnect.spec.ts and
// vault-reconnect.spec.ts. external-edits.spec.ts covers the external write
// itself (`store.writeExternal`).
import { expect, test, type Page } from "@playwright/test";

const SCRATCH = "/harness/scratch";
const ALPHA = `${SCRATCH}/alpha.md`;

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// A write nothing tells the app about: the other device's save, a git
// checkout, an agent working in a drawer. No `__harness.notesChanged` follows
// it, since these specs cover the push that never came.
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

// The refresh reloads the note that is open in the editor.
test("a note rewritten while the wire was down pours into the open editor on reconnect", async ({ page }) => {
  await wroteWhileAway(page, ALPHA, "# Alpha\n\nthe version from the other device\n");

  await reconnect(page);

  await expect(page.locator(".cm-content")).toContainText("the version from the other device");
});

// The note lists refresh through a different path than the editor does. The
// editor follows through reloadOpenNotes, the sidebar through refreshFolder. A
// note that appeared while the wire was down has no open tab to follow.
test("a note that appeared while the wire was down joins the list on reconnect", async ({ page }) => {
  await wroteWhileAway(page, `${SCRATCH}/newcomer.md`, "# Newcomer\n\nwritten on the other machine\n");
  await expect(noteRow(page, "Newcomer")).toHaveCount(0);

  await reconnect(page);

  await expect(noteRow(page, "Newcomer")).toBeVisible();
});

// The tags and backlinks panels carry no reconnect subscription of their own
// (notes/channel.ts). They re-fetch when the store's note list for their
// folder changes, and the refresh changes it. If that stops being true, this
// spec fails instead of the panels going stale on every phone reconnect.
test("the tags panel follows the refresh, with no subscription of its own", async ({ page }) => {
  await page.keyboard.press("Alt+Meta+t");
  await expect(page.locator("aside", { hasText: "Tags" })).toBeVisible();

  await wroteWhileAway(page, `${SCRATCH}/tagged-elsewhere.md`, "# Tagged Elsewhere\n\nfiled under #shipped\n");
  await expect(page.locator('[data-target-kind="tag"]', { hasText: "shipped" })).toHaveCount(0);

  await reconnect(page);

  await expect(page.locator('[data-target-kind="tag"]', { hasText: "shipped" })).toBeVisible();
});

// A reconnect must not throw away unsaved text. The refresh reloads clean
// buffers only (notes/store.ts reloadCandidates), and reusing that one refresh
// keeps the guard. A reconnect wired to a blunter reload would clobber the
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
// The case above is a wire that flapped. The ladder holds writes across a flap
// and lands them, so the danger there is the refresh, and taking the typed text
// away would be the clobber. This is the other case: the ladder ran out and
// saving was held for the buffer's note (notes/store.ts holdSaves). By the time
// the server is reachable its copy has moved on, because another device was
// editing the same note.
//
// The server's version wins here, the reverse of the flapped case. Neither
// version is lost: the buffer's text goes to the trash, and restoring it lands
// that copy beside the live note to merge (remote.md §7).

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
  // No save landed while the connection was lost.
  await expect(unsavedDot(page)).toHaveAttribute("data-unsaved", "stranded");

  // Meanwhile the other device rewrites the same note.
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

// The ordinary outage: nobody else touched the note. The buffer is written
// once there is somewhere to write it, nothing is displaced into the trash,
// and no notice appears.
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

// The dot on the tab (workspace/PaneTree.tsx). This test drives only the
// stranded state, where the dot's title names the server that cannot be
// reached. The plain "Not saved yet." state is not exercised here. A saved
// note shows no dot at all.
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
