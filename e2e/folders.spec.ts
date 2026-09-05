// The note browser's folder tree, driven end-to-end in headless WebKit:
// disclosure, the row grammar on a kind of row that is not a note, filing a
// note by menu and by drag, and where a folder's name shows up once the list
// is flat (quick-open).
//
// The `?folders` fixture files the scratch workspace's notes: Alpha at the top
// level, Beta in projects/, Gamma in projects/api/, Delta in admin/.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });
const folderRow = (page: Page, name: string) =>
  page.locator('[data-target-kind="folder"]', { hasText: name });

const focusedRowKey = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.["listRow"] ?? null);

// The browser's rows in order, as "folder/" or a note title — the tree's shape
// as a reader sees it.
const treeRows = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-target-kind="folder"], [data-target-kind="note"]')).map(
      (el) => (el.dataset["targetKind"] === "folder" ? `${el.dataset["targetFolder"]}/` : el.textContent?.trim()),
    ),
  );

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html?folders");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test.describe("the tree", () => {
  test("folders come first and collapsed, with the count of what they hide", async ({ page }) => {
    // Nothing is expanded at boot, so the notes inside a folder are not rows.
    expect(await treeRows(page)).toEqual(["admin/", "projects/", "Alpha"]);
    await expect(folderRow(page, "projects")).toContainText("2"); // Beta + Gamma, one level down
  });

  test("clicking a folder expands it; clicking again collapses it", async ({ page }) => {
    await folderRow(page, "projects").click();
    expect(await treeRows(page)).toEqual(["admin/", "projects/", "projects/api/", "Beta", "Alpha"]);
    await folderRow(page, "projects").first().click();
    expect(await treeRows(page)).toEqual(["admin/", "projects/", "Alpha"]);
  });

  test("collapsing a parent hides an expanded child's notes too", async ({ page }) => {
    await folderRow(page, "projects").click();
    await folderRow(page, "api").click();
    expect(await treeRows(page)).toContain("Gamma");
    await folderRow(page, "projects").first().click();
    expect(await treeRows(page)).toEqual(["admin/", "projects/", "Alpha"]);
  });

  test("Enter on a focused folder row is its disclosure, and the arrows walk both kinds", async ({ page }) => {
    // R5/R6 on a row kind that is not a note: the tree is one keyboard list,
    // and the click that focused admin also opened it, so its note is the next
    // row down.
    await folderRow(page, "admin").click();
    expect(await focusedRowKey(page)).toBe("dir:admin");
    await page.keyboard.press("ArrowDown");
    expect(await focusedRowKey(page)).toMatch(/delta\.md$/);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter"); // Enter is the disclosure: collapse
    expect(await treeRows(page)).toEqual(["admin/", "projects/", "Alpha"]);
    await page.keyboard.press("Enter"); // and expand again
    expect(await treeRows(page)).toContain("Delta");
  });

  test("a note opens from inside a folder", async ({ page }) => {
    await folderRow(page, "admin").click();
    await noteRow(page, "Delta").click();
    await expect(page.locator(".cm-content").first()).toContainText("delta body");
  });
});

test.describe("filing a note", () => {
  test("Move to Folder… files the note and reveals it where it landed", async ({ page }) => {
    await noteRow(page, "Alpha").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Folder…" }).click();
    await page.getByTestId("folder-picker-field").fill("admin");
    await page.getByTestId("folder-picker-row").first().click();
    // The destination is expanded by the move, so the note is on screen where
    // it now lives rather than behind a closed disclosure.
    expect(await treeRows(page)).toEqual(["admin/", "Alpha", "Delta", "projects/"]);
  });

  test("a folder typed into the chooser is created by the move", async ({ page }) => {
    await noteRow(page, "Alpha").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Folder…" }).click();
    await page.getByTestId("folder-picker-field").fill("trips");
    await page.getByTestId("folder-picker-create").click();
    expect(await treeRows(page)).toEqual(["admin/", "projects/", "trips/", "Alpha"]);
  });

  test("Move to Folder… can bring a note back to the top level, and the emptied folder goes with it", async ({ page }) => {
    // The browser shows the folders its notes are in (notes/folders.ts), so
    // taking the last note out of `admin` takes the row too. The directory is
    // still on disk; nothing in the app has a reason to draw it.
    await folderRow(page, "admin").click();
    await noteRow(page, "Delta").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Folder…" }).click();
    await page.getByRole("dialog").getByText("Top level").click();
    expect(await treeRows(page)).toEqual(["projects/", "Alpha", "Delta"]);
  });

  test("the open note's tab follows it across a move", async ({ page }) => {
    // The docId is untouched by a move (architecture.md §4), so the editor and
    // its text live through it; what changes is the file the tab points at.
    await noteRow(page, "Alpha").click();
    await expect(page.locator(".cm-content").first()).toContainText("alpha body");
    await noteRow(page, "Alpha").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Folder…" }).click();
    await page.getByTestId("folder-picker-field").fill("admin");
    await page.getByTestId("folder-picker-row").first().click();
    await expect(noteRow(page, "Alpha")).toHaveAttribute("data-target-path", /\/admin\/alpha\.md$/);
    await expect(page.locator(".cm-content").first()).toContainText("alpha body");
  });

  test("Escape leaves the chooser without filing anything", async ({ page }) => {
    await noteRow(page, "Alpha").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Folder…" }).click();
    await page.getByTestId("folder-picker-field").fill("trips");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await treeRows(page)).toEqual(["admin/", "projects/", "Alpha"]);
  });
});

test.describe("dragging a note", () => {
  test("dropping a note on a folder row files it there", async ({ page }) => {
    // A pointer gesture, not a command (R4): its affordance is the drop
    // target's highlight. It goes through the same moveNoteTo as the menu
    // item, so the two cannot mean different things.
    await noteRow(page, "Alpha").dragTo(folderRow(page, "admin"));
    await expect(noteRow(page, "Alpha")).toHaveAttribute("data-target-path", /\/admin\/alpha\.md$/);
    expect(await treeRows(page)).toEqual(["admin/", "Alpha", "Delta", "projects/"]);
  });

  test("dropping a note on the Notes header brings it to the top level", async ({ page }) => {
    // The one destination with no row of its own.
    await folderRow(page, "admin").click();
    await noteRow(page, "Delta").dragTo(page.getByText("Notes", { exact: true }));
    await expect(noteRow(page, "Delta")).toHaveAttribute("data-target-path", /scratch\/delta\.md$/);
  });
});

test.describe("creating", () => {
  test("New Note in Folder opens an Untitled note inside that folder", async ({ page }) => {
    await folderRow(page, "admin").click({ button: "right" });
    await page.getByRole("menuitem", { name: "New Note in Folder" }).click();
    // Expanded by the create, with the new note's row inside it.
    await expect(noteRow(page, "Untitled")).toBeVisible();
    await expect(noteRow(page, "Untitled")).toHaveAttribute("data-target-path", /\/admin\//);
  });

  test("New Folder… makes the folder and the first note in it", async ({ page }) => {
    // A folder is in the browser because a note is in it, so New Folder cannot
    // stop at the directory: it would make a folder nothing could show.
    await page.getByRole("button", { name: "New note options" }).click();
    await page.getByRole("menuitem", { name: "New Folder…" }).click();
    await page.getByTestId("folder-picker-field").fill("trips");
    await page.getByTestId("folder-picker-create").click();
    await expect(folderRow(page, "trips")).toBeVisible();
    await expect(noteRow(page, "Untitled")).toHaveAttribute("data-target-path", /\/trips\//);
  });

  test("New Folder… on a folder row nests inside it", async ({ page }) => {
    await folderRow(page, "admin").click({ button: "right" });
    await page.getByRole("menuitem", { name: "New Folder…" }).click();
    // The field is seeded with the row's folder, so nesting is a name and an
    // Enter rather than a path typed from the top.
    await expect(page.getByTestId("folder-picker-field")).toHaveValue("admin/");
    await page.getByTestId("folder-picker-field").fill("admin/tax");
    await page.getByTestId("folder-picker-create").click();
    await expect(folderRow(page, "tax")).toBeVisible();
  });
});

test.describe("where a note lives, once the list is flat", () => {
  test("quick-open names the folder beside the title", async ({ page }) => {
    // The sidebar answers "which folder" by position; ⌘P has no position to
    // answer with, and two notes may now share a title.
    await page.keyboard.press("Meta+p");
    await page.getByPlaceholder("Search notes").fill("Gamma");
    await expect(page.getByTestId("note-folder")).toHaveText("projects/api");
  });

  test("a top-level note gets no folder label at all", async ({ page }) => {
    await page.keyboard.press("Meta+p");
    await page.getByPlaceholder("Search notes").fill("Alpha");
    await expect(page.getByTestId("note-folder")).toHaveCount(0);
  });
});

test.describe("searching one folder", () => {
  // Every note in the fixture says "<name> body", so one query reaches all
  // four and the scope is the only thing that can change the answer.
  const rows = (page: Page) => page.getByTestId("overlay-list").locator("> div");

  test("Search in Folder narrows the text search to that folder and the ones inside it", async ({ page }) => {
    await folderRow(page, "projects").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Search in Folder" }).click();
    // The scope is on screen before a character is typed: a search that found
    // nothing must never be mistakable for a workspace that holds nothing.
    await expect(page.getByTestId("overlay-scope")).toHaveText("projects");
    await page.getByPlaceholder("Search inside notes").fill("body");
    // Beta sits in projects, Gamma one level further down in projects/api.
    // Alpha (top level) and Delta (admin) are the controls.
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId("overlay-list")).toContainText("Beta");
    await expect(page.getByTestId("overlay-list")).toContainText("Gamma");
    await expect(page.getByTestId("overlay-list")).not.toContainText("Delta");
  });

  test("`/` on a focused folder row is the same verb", async ({ page }) => {
    await folderRow(page, "admin").click();
    await page.keyboard.press("/");
    await expect(page.getByTestId("overlay-scope")).toHaveText("admin");
    await page.getByPlaceholder("Search inside notes").fill("body");
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId("overlay-list")).toContainText("Delta");
  });

  test("the scope crosses to Notes with the chips, and clearing it widens both", async ({ page }) => {
    // The scope belongs to the overlay, not to one of its modes: what you were
    // looking IN survives a crossing exactly as what you were looking for does.
    await folderRow(page, "projects").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Search in Folder" }).click();
    await page.getByRole("button", { name: "Notes" }).click();
    await expect(page.getByTestId("overlay-scope")).toHaveText("projects");
    await expect(page.getByTestId("overlay-list")).not.toContainText("Alpha");
    // The pill is its own removal, and the list widens under it.
    await page.getByTestId("overlay-scope").click();
    await expect(page.getByTestId("overlay-scope")).toHaveCount(0);
    await expect(page.getByTestId("overlay-list")).toContainText("Alpha");
  });

  test("Backspace at an empty field drops the scope, the way it drops a sigil", async ({ page }) => {
    await folderRow(page, "projects").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Search in Folder" }).click();
    await page.getByPlaceholder("Search inside notes").fill("body");
    await expect(rows(page)).toHaveCount(2);
    // One Backspace per typed character empties the field but leaves the pill:
    // the scope is not one more character of the query.
    for (let i = 0; i < "body".length; i++) await page.keyboard.press("Backspace");
    await expect(page.getByTestId("overlay-scope")).toHaveCount(1);
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("overlay-scope")).toHaveCount(0);
  });

  test("the scope is not drawn over the commands list, which it does not narrow", async ({ page }) => {
    await folderRow(page, "projects").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Search in Folder" }).click();
    await page.getByRole("button", { name: "Commands" }).click();
    await expect(page.getByTestId("overlay-scope")).toHaveCount(0);
    // Not forgotten, though: crossing back brings the scope and its rows back
    // together.
    await page.getByRole("button", { name: "Text" }).click();
    await expect(page.getByTestId("overlay-scope")).toHaveText("projects");
  });
});
