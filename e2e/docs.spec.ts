// The built-in documentation. On a shell with windows the manual gets one of
// its own (remote.md §8a): the help button asks the shell for it and the
// workspace in front of you is left alone. That window is another webview
// running this same view, which a spec reaches the way the shell does — by
// loading the harness as it (`?docs=1`) — and inside it the manual is a
// read-only workspace whose pages open, search, and RUN like ordinary notes,
// while nothing edits, creates, or deletes: the affordances hide, the editor
// drops keystrokes, and the harness store (like the real one) refuses any
// write that slips past.
//
// A client with one window and no way to have two (a phone, ios.md §4) keeps
// the old behavior, and the last cases here are its.
import { expect, test, type Page } from "@playwright/test";

const wsRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="workspace"]', { hasText: name });
const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const docsButton = (page: Page) => page.getByTitle("Documentation", { exact: true });

// The manual's window, as the shell opens it: `page` is the title it was asked
// for, "" its landing page.
async function openDocsWindow(page: Page, title = ""): Promise<void> {
  await page.goto(`/harness.html?docs=1${title ? `&page=${encodeURIComponent(title)}` : ""}`);
  await expect(page.locator("[data-tab]")).toHaveCount(1);
}

test.describe("an ordinary window", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html");
    await expect(noteRow(page, "Alpha")).toBeVisible();
  });

  // The change this window makes: the manual no longer takes the workspace
  // over. The button asks the shell for the manual's window and nothing here
  // moves — same workspace, same tabs, same notes in the browser.
  test("the help button asks the shell for the manual's window, and changes nothing here", async ({ page }) => {
    await docsButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__harness.docsOpens())).toEqual([""]);
    await expect(noteRow(page, "Alpha")).toBeVisible();
    await expect(noteRow(page, "Getting Started")).toHaveCount(0);
    await expect(wsRow(page, "Documentation")).toHaveCount(0);
  });

  // Asking again raises the window that is already open — the shell's job, and
  // from here indistinguishable from opening one. What matters is that the ask
  // leaves every time: a button that stops working the second time is the dead
  // end the old toggle existed to avoid.
  test("the button asks every time it is pressed", async ({ page }) => {
    await docsButton(page).click();
    await docsButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__harness.docsOpens())).toEqual(["", ""]);
  });

  // Help > Third-Party Licenses means one page rather than the manual, and the
  // page rides the same ask (the shell shows it whether it opens the window or
  // raises one that was already up).
  test("Third-Party Licenses names the page in the ask", async ({ page }) => {
    await page.keyboard.press("Meta+Shift+P");
    await page.getByPlaceholder("Run a command").fill("Third-Party");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.__harness.docsOpens()))
      .toEqual(["Third-Party Licenses"]);
  });

  test("the palette's Documentation entry is the other doorway", async ({ page }) => {
    await page.keyboard.press("Meta+Shift+P");
    await page.getByPlaceholder("Run a command").fill("Documentation");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.__harness.docsOpens())).toEqual([""]);
  });
});

test.describe("the manual's window", () => {
  test.beforeEach(async ({ page }) => {
    await openDocsWindow(page);
  });

  test("opens on Getting Started, with the pages as its sidebar", async ({ page }) => {
    // Landed on the page, not a scratch tab: the tab bar names it.
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toBeVisible();
    await expect(page.locator(".cm-line").first()).toHaveText("# Getting Started");
    await expect(page.getByText("read-only")).toBeVisible();
    // Every page lists; the user's notes are not in this window at all.
    await expect(noteRow(page, "Workspaces Guide")).toBeVisible();
    await expect(noteRow(page, "Alpha")).toHaveCount(0);
  });

  // The window holds one workspace and it is the manual, so the surfaces that
  // switch between workspaces or between machines have nothing to say: the
  // strip would be an empty list under a heading, and the connection bar would
  // name a machine this window cannot be pointed off.
  test("no workspace strip, no connection bar, and no help button", async ({ page }) => {
    await expect(page.getByText("Workspaces", { exact: true })).toHaveCount(0);
    await expect(page.locator("[data-connection]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New Workspace" })).toHaveCount(0);
    await expect(docsButton(page)).toHaveCount(0);
  });

  // The verbs that would act on a workspace this window does not have, or on a
  // machine it cannot reach, are absent from the palette rather than present
  // and failing (interactions.md §4).
  test("the palette drops the workspace and machine verbs", async ({ page }) => {
    await page.keyboard.press("Meta+Shift+P");
    const palette = page.getByPlaceholder("Run a command");
    for (const verb of ["New Workspace", "Attach Folder", "Notes On"]) {
      await palette.fill(verb);
      await expect(page.locator("[data-active]")).toHaveCount(0);
    }
    // New Window is still there: this is a dead end for workspaces, not for
    // the app.
    await palette.fill("New Window");
    await expect(page.locator("[data-active]")).toContainText("New Window");
  });

  test("the editor is read-only: keystrokes land nowhere, and no save ever fires", async ({ page }) => {
    const first = page.locator(".cm-line").first();
    await first.click();
    await page.keyboard.type("VANDALIZED");
    await expect(first).toHaveText("# Getting Started");
    // The fake store's page is untouched (no autosave snuck through).
    const text = await page.evaluate(() =>
      window.__harness.store.readNote("/harness/.ledge-docs/01-getting-started.md"),
    );
    expect(text).toContain("# Getting Started");
    expect(text).not.toContain("VANDALIZED");
  });

  test("read-only is no bar to running: an unmarked block on a page still runs", async ({ page }) => {
    // The real manual marks every block `norun` (bun/docsContent.test.ts);
    // this fixture leaves one unmarked so the read-only editor's own stance is
    // what is tested — the mark, not the read-only page, withholds a run.
    await page.locator(".cm-line", { hasText: "echo hello from the docs" }).click();
    await page.keyboard.press("Meta+Enter");
    await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
  });

  test("no create or delete affordances: buttons hidden, row menu trimmed, verbs refused", async ({ page }) => {
    // The browser's New Note footer and the tab strip's + are gone.
    await expect(page.getByRole("button", { name: "New Note" })).toHaveCount(0);
    await expect(page.getByTitle(/New Note/)).toHaveCount(0);
    // The row menu carries Open and Copy Path — no Delete, no lock faces.
    await noteRow(page, "Getting Started").click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Delete/ })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: /Lock/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // The bare `d` row verb is gated too: the row (and the page) survive.
    await noteRow(page, "Getting Started").click();
    await page.keyboard.press("d");
    await expect(noteRow(page, "Getting Started")).toBeVisible();
  });

  test("splitting opens an empty pane, and the next page opened fills it", async ({ page }) => {
    // Splitting is a READING move here (two pages side by side), so it stays
    // enabled — but the seeded scratch tab every other workspace gets would be
    // an Untitled that the read-only editor never lets you type in or save.
    await page.keyboard.press("Meta+d");
    await expect(page.locator("[data-tab]", { hasText: "Untitled" })).toHaveCount(0);
    // The new pane shows the empty state, and even there nothing offers to create.
    await expect(page.getByText("No open notes")).toBeVisible();
    await expect(page.getByRole("button", { name: "New Note" })).toHaveCount(0);
    // It holds focus, so the next page opened lands in it: two pages, one each.
    await noteRow(page, "Workspaces Guide").click();
    await expect(page.locator("[data-tab]", { hasText: "Workspaces Guide" })).toHaveCount(1);
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toHaveCount(1);
    await expect(page.getByText("No open notes")).toHaveCount(0);
  });

  test("pages list in manifest order (numbered paths), not alphabetically by title", async ({ page }) => {
    // About Panes sorts FIRST by title but its filename (03-) sorts last: the
    // browser must show the manifest's reading order, Getting Started on top.
    const titles = page.locator('[data-target-kind="note"]');
    await expect(titles).toHaveText([
      /Getting Started/,
      /Workspaces Guide/,
      /About Panes/,
      /Third-Party Licenses/,
    ]);
  });

  test("⌘P and ⌥⌘P search the manual", async ({ page }) => {
    await page.keyboard.press("Meta+p");
    const quick = page.getByPlaceholder(/Search notes/);
    await quick.fill("getting");
    await expect(page.locator("[data-active]")).toContainText("Getting Started");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Alt+Meta+p");
    await page.getByPlaceholder("Search inside notes").fill("docs needle");
    await expect(page.locator("[data-active]")).toContainText("Getting Started");
  });

  // The notices ship inside the app because their licenses ask to travel with
  // the binary, so the one thing this must do is land on that page — including
  // when the manual is open on some other page, which is the case the shell
  // routes here rather than opening a second window for (rpc docsShow).
  test("a page asked for while this window is open lands on it", async ({ page }) => {
    await expect(page.locator(".cm-line").first()).toHaveText("# Getting Started");
    await page.evaluate(() => window.__harness.showDocs("Third-Party Licenses"));
    await expect(page.locator("[data-tab]", { hasText: "Third-Party Licenses" })).toBeVisible();
    await expect(page.locator(".cm-line").first()).toHaveText("# Third-Party Licenses");
  });

  // Opened FOR a page: the window boots straight onto it, which is what
  // Help > Third-Party Licenses does when the manual was not already up.
  test("a window opened for a page opens on that page", async ({ page }) => {
    await openDocsWindow(page, "Third-Party Licenses");
    await expect(page.locator(".cm-line").first()).toHaveText("# Third-Party Licenses");
  });

  // The help button pressed again asks for the manual with no page: the shell
  // raises this window, and raising it is all that was asked for. Losing the
  // reader's place would be a worse answer than doing nothing.
  test("the bare ask raises the window without moving off the page being read", async ({ page }) => {
    await noteRow(page, "About Panes").click();
    await expect(page.locator(".cm-line").first()).toHaveText("# About Panes");
    await page.evaluate(() => window.__harness.showDocs(""));
    await expect(page.locator(".cm-line").first()).toHaveText("# About Panes");
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toHaveCount(1);
  });

  // The exception, and the reason the bare ask is not simply ignored: a window
  // raised onto an empty pane looks like a dead button.
  test("with nothing open, the bare ask lands on Getting Started", async ({ page }) => {
    await page.keyboard.press("Meta+w");
    await expect(page.locator("[data-tab]")).toHaveCount(0);
    await page.evaluate(() => window.__harness.showDocs(""));
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toBeVisible();
  });

  // Turning to the licences page from inside the manual is the one docs verb
  // this window keeps, and it acts here rather than asking for a window.
  test("Third-Party Licenses turns to the page in this window", async ({ page }) => {
    await page.keyboard.press("Meta+Shift+P");
    await page.getByPlaceholder("Run a command").fill("Third-Party");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-tab]", { hasText: "Third-Party Licenses" })).toBeVisible();
    expect(await page.evaluate(() => window.__harness.docsOpens())).toEqual([]);
  });
});

// A client with one window and no way to have two: the manual takes the window
// over, and the same button — lit, since the manual is now the selected
// workspace — is the way back. The strip that would otherwise offer one is
// inside the drawer the manual is covering (ios.md §9).
test.describe("a client with one window", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(noteRow(page, "Alpha")).toBeVisible();
  });

  test("the manual opens in the window there is, and the button puts it away", async ({ page }) => {
    await docsButton(page).click();
    await expect(noteRow(page, "Getting Started")).toBeVisible();
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toBeVisible();
    // No window was asked for: there is none to ask for.
    expect(await page.evaluate(() => window.__harness.docsOpens())).toEqual([]);
    // Still no strip row — the way back is this button.
    await expect(wsRow(page, "Documentation")).toHaveCount(0);

    await docsButton(page).click();
    await expect(noteRow(page, "Alpha")).toBeVisible();
    await expect(noteRow(page, "Getting Started")).toHaveCount(0);
    // Nothing was closed, only deselected: coming back costs no reload and
    // lands where it was left.
    await docsButton(page).click();
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toHaveCount(1);
  });

  // The regression the landing rule exists for: a docs workspace with every
  // page closed (an empty pane — closeTab does not reseed) has no strip row and
  // nothing on screen, so a click that merely re-selects it looks like a dead
  // button. It must open the landing page.
  test("reopening after closing every docs tab lands back on Getting Started", async ({ page }) => {
    await docsButton(page).click();
    await expect(noteRow(page, "Getting Started")).toBeVisible();
    await page.keyboard.press("Meta+w"); // close Getting Started; the pane empties
    await expect(page.locator("[data-tab]")).toHaveCount(0);
    await page.keyboard.press("Meta+1"); // leave for the user's workspace
    await expect(noteRow(page, "Alpha")).toBeVisible();
    await docsButton(page).click();
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toBeVisible();
    await expect(page.locator(".cm-line").first()).toHaveText("# Getting Started");
  });

  // Third-Party Licenses has to land on the notices page here too, including
  // from another docs page, where "the docs are already open" would otherwise
  // be answered by leaving you where you are.
  test("Third-Party Licenses lands on the notices page, even from another docs page", async ({ page }) => {
    await docsButton(page).click();
    await expect(page.locator(".cm-line").first()).toHaveText("# Getting Started");
    await page.keyboard.press("Meta+Shift+P");
    await page.getByPlaceholder("Run a command").fill("Third-Party");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-tab]", { hasText: "Third-Party Licenses" })).toBeVisible();
    await expect(page.locator(".cm-line").first()).toHaveText("# Third-Party Licenses");
  });
});
