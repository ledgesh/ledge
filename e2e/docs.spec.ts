// The built-in documentation. On a shell with windows the manual opens in a
// window of its own (remote.md §8a), another webview running this same view.
// A spec reaches that window the way the shell does, by loading the harness
// page with `?docs=1` rather than by clicking the help button. Inside it the
// manual is a read-only workspace, and the harness store enforces that the
// way the real store does.
//
// A phone has one window and no way to open a second (ios.md §11). There the
// manual takes over the window it has, and the last cases here cover that.
import { expect, test, type Page } from "@playwright/test";

const wsRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="workspace"]', { hasText: name });
const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const docsButton = (page: Page) => page.getByTitle("Documentation", { exact: true });

// The manual's window, as the shell opens it. `title` is the page the window
// was opened for, and "" opens it on the landing page.
async function openDocsWindow(page: Page, title = ""): Promise<void> {
  await page.goto(`/harness.html?docs=1${title ? `&page=${encodeURIComponent(title)}` : ""}`);
  await expect(page.locator("[data-tab]")).toHaveCount(1);
}

test.describe("an ordinary window", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html");
    await expect(noteRow(page, "Alpha")).toBeVisible();
  });

  // The button asks the shell for the manual's window, and this window keeps
  // what it had: same workspace, same tabs, same notes in the browser. The
  // manual does not take the workspace over here.
  test("the help button asks the shell for the manual's window, and changes nothing here", async ({ page }) => {
    await docsButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__harness.docsOpens())).toEqual([""]);
    await expect(noteRow(page, "Alpha")).toBeVisible();
    await expect(noteRow(page, "Getting Started")).toHaveCount(0);
    await expect(wsRow(page, "Documentation")).toHaveCount(0);
  });

  // Asking again raises the window that is already open. Raising it is the
  // shell's job, and from here it looks the same as opening one. Every press
  // sends the ask, because a button that does nothing on its second press is
  // a dead end. On a client with one window the second press puts the manual
  // away instead (registry.ts docs.toggle, and the last describe here).
  test("the button asks every time it is pressed", async ({ page }) => {
    await docsButton(page).click();
    await docsButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__harness.docsOpens())).toEqual(["", ""]);
  });

  // Help > Third-Party Licenses asks for one page rather than the manual, and
  // the page title is passed with the same ask. The shell shows that page
  // whether it opens the window or raises one already up.
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

  // The window holds one workspace, the manual, so the surfaces that switch
  // between workspaces or between machines have nothing to show: the strip
  // would be an empty list under a heading, and the connection bar would name
  // a machine this window cannot be switched away from.
  test("no workspace strip, no connection bar, and no help button", async ({ page }) => {
    await expect(page.getByText("Workspaces", { exact: true })).toHaveCount(0);
    await expect(page.locator("[data-connection]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New Workspace" })).toHaveCount(0);
    await expect(docsButton(page)).toHaveCount(0);
  });

  // The verbs that would act on a workspace this window does not have, or on a
  // machine it cannot reach, are absent from the palette rather than present
  // and failing (interactions.md §8).
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
    // The real manual marks every fence in a runnable language `norun`
    // (bun/docsContent.test.ts). This fixture leaves one unmarked, so what is
    // tested here is the read-only editor alone: `norun` withholds a run, and
    // being read-only does not.
    await page.locator(".cm-line", { hasText: "echo hello from the docs" }).click();
    await page.keyboard.press("Meta+Enter");
    await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
  });

  test("no create or delete affordances: buttons hidden, row menu trimmed, verbs refused", async ({ page }) => {
    // The browser's New Note footer and the tab strip's + are gone.
    await expect(page.getByRole("button", { name: "New Note" })).toHaveCount(0);
    await expect(page.getByTitle(/New Note/)).toHaveCount(0);
    // The row menu carries Open and Copy Path, with no Delete and no lock
    // faces.
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
    // Splitting is a reading move here (two pages side by side), so it stays
    // enabled. The scratch tab every other workspace seeds into the new pane
    // would be an Untitled the read-only editor refuses to type into or save.
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
    // About Panes sorts first by title but third by filename (03-), so the
    // browser must show the manifest's reading order rather than the titles:
    // Getting Started on top.
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

  // The notices ship with the app because their licenses ask to travel with
  // the binary. A request for that page lands on it even when the manual is
  // open on another page: the shell routes such a request into this window
  // rather than opening a second one (rpc docsShow).
  test("a page asked for while this window is open lands on it", async ({ page }) => {
    await expect(page.locator(".cm-line").first()).toHaveText("# Getting Started");
    await page.evaluate(() => window.__harness.showDocs("Third-Party Licenses"));
    await expect(page.locator("[data-tab]", { hasText: "Third-Party Licenses" })).toBeVisible();
    await expect(page.locator(".cm-line").first()).toHaveText("# Third-Party Licenses");
  });

  // Opened for a page: the window boots straight onto it. That is what
  // Help > Third-Party Licenses does when the manual was not already up.
  test("a window opened for a page opens on that page", async ({ page }) => {
    await openDocsWindow(page, "Third-Party Licenses");
    await expect(page.locator(".cm-line").first()).toHaveText("# Third-Party Licenses");
  });

  // The help button pressed again asks for the manual with no page. The shell
  // raises this window, and the view leaves the page being read alone: with a
  // tab open, a bare ask opens nothing (App.tsx onDocsShow). Turning to the
  // landing page would lose the reader's place.
  test("the bare ask raises the window without moving off the page being read", async ({ page }) => {
    await noteRow(page, "About Panes").click();
    await expect(page.locator(".cm-line").first()).toHaveText("# About Panes");
    await page.evaluate(() => window.__harness.showDocs(""));
    await expect(page.locator(".cm-line").first()).toHaveText("# About Panes");
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toHaveCount(1);
  });

  // With no tab open, the bare ask does open the landing page. A window raised
  // onto an empty pane would look like a dead button.
  test("with nothing open, the bare ask lands on Getting Started", async ({ page }) => {
    await page.keyboard.press("Meta+w");
    await expect(page.locator("[data-tab]")).toHaveCount(0);
    await page.evaluate(() => window.__harness.showDocs(""));
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toBeVisible();
  });

  // This window keeps one docs verb: turning to the licences page. It acts
  // here rather than asking the shell for a window.
  test("Third-Party Licenses turns to the page in this window", async ({ page }) => {
    await page.keyboard.press("Meta+Shift+P");
    await page.getByPlaceholder("Run a command").fill("Third-Party");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-tab]", { hasText: "Third-Party Licenses" })).toBeVisible();
    expect(await page.evaluate(() => window.__harness.docsOpens())).toEqual([]);
  });
});

// A client with one window and no way to open a second. The manual takes the
// window over, and the same button is the way back (lit, since the manual is
// now the selected workspace). No strip row leads back: the docs workspace is
// filtered out of the strip on every client (registry.ts stripWorkspaces,
// Sidebar.tsx).
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
    // Still no strip row: the way back is this button.
    await expect(wsRow(page, "Documentation")).toHaveCount(0);

    await docsButton(page).click();
    await expect(noteRow(page, "Alpha")).toBeVisible();
    await expect(noteRow(page, "Getting Started")).toHaveCount(0);
    // Nothing was closed, only deselected: coming back costs no reload and
    // lands where it was left.
    await docsButton(page).click();
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toHaveCount(1);
  });

  // A docs workspace with every page closed has an empty pane (closeTab does
  // not reseed) and no strip row, so a click that only re-selected it would
  // show nothing and look like a dead button. The click opens the landing page
  // instead, and this is the regression that rule exists for.
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
  // from another docs page. Treating the manual as already open would leave
  // the reader on the page they were on.
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
