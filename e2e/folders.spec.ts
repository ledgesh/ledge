// The note browser's folder tree, driven in headless WebKit: disclosure, the
// row verbs on a folder row, filing a note by menu and by drag, and the folder
// label quick-open shows beside a title.
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

// The browser's rows in order: "folder/" for a folder row, the title for a
// note row.
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
    await expect(folderRow(page, "projects")).toContainText("2"); // Beta in projects, Gamma in projects/api
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
    // The arrows walk folder rows and note rows alike, because the tree is one
    // keyboard list (interactions.md R5), and Enter is a folder row's primary
    // action (R6). The click that focused admin also opened it, so its note is
    // the next row down.
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
    // The move expands the destination, so the note is on screen where it now
    // lives rather than behind a closed disclosure.
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
    // The browser draws the folders its notes are in (notes/folders.ts), so
    // taking the last note out of `admin` takes the row too. The directory
    // itself stays on disk.
    await folderRow(page, "admin").click();
    await noteRow(page, "Delta").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Folder…" }).click();
    await page.getByRole("dialog").getByText("Top level").click();
    expect(await treeRows(page)).toEqual(["projects/", "Alpha", "Delta"]);
  });

  test("the open note's tab follows it across a move", async ({ page }) => {
    // A move leaves the docId untouched (architecture.md §4), so the editor
    // keeps its text. Only the file the tab points at changes.
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
    // Dragging a row is a pointer gesture rather than a command
    // (interactions.md R4), so the highlight on the drop target is the only
    // cue it gets. The drop and the menu item both go through NoteBrowser.tsx's
    // `file` helper, which calls notes/actions.ts moveNoteTo, so the two cannot
    // behave differently.
    await noteRow(page, "Alpha").dragTo(folderRow(page, "admin"));
    await expect(noteRow(page, "Alpha")).toHaveAttribute("data-target-path", /\/admin\/alpha\.md$/);
    expect(await treeRows(page)).toEqual(["admin/", "Alpha", "Delta", "projects/"]);
  });

  test("dropping a note on the Notes header brings it to the top level", async ({ page }) => {
    // The top level is the one destination with no row of its own.
    await folderRow(page, "admin").click();
    await noteRow(page, "Delta").dragTo(page.getByText("Notes", { exact: true }));
    await expect(noteRow(page, "Delta")).toHaveAttribute("data-target-path", /scratch\/delta\.md$/);
  });
});

test.describe("creating", () => {
  test("New Note in Folder opens an Untitled note inside that folder", async ({ page }) => {
    await folderRow(page, "admin").click({ button: "right" });
    await page.getByRole("menuitem", { name: "New Note in Folder" }).click();
    // The create expands the folder, so the new note's row is inside it.
    await expect(noteRow(page, "Untitled")).toBeVisible();
    await expect(noteRow(page, "Untitled")).toHaveAttribute("data-target-path", /\/admin\//);
  });

  test("New Folder… makes the folder and the first note in it", async ({ page }) => {
    // The browser draws a folder because a note is in it (notes/folders.ts),
    // so a directory holding no note gets no row. New Folder therefore creates
    // a note as well, or the folder it just made would not appear.
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
    // The field opens seeded with the row's folder, so a name typed after it
    // nests without retyping the path. The `fill` below replaces the value
    // rather than appending to it, so it spells the whole path out.
    await expect(page.getByTestId("folder-picker-field")).toHaveValue("admin/");
    await page.getByTestId("folder-picker-field").fill("admin/tax");
    await page.getByTestId("folder-picker-create").click();
    await expect(folderRow(page, "tax")).toBeVisible();
  });
});

test.describe("renaming a folder", () => {
  // The rename field, located by its row's kind rather than by the row's text.
  // Once the field opens the name is the input's value, and a hasText match
  // does not see it.
  const field = (page: Page) => page.locator('[data-target-kind="folder"]').getByRole("textbox");

  test("`r` opens a field on the row, and committing renames the folder", async ({ page }) => {
    await folderRow(page, "admin").click(); // focuses the row (and opens it)
    await page.keyboard.press("r");
    await expect(field(page)).toBeVisible();
    // The field is seeded with the name, not the path: a rename changes what
    // the folder is called, not where it sits.
    await expect(field(page)).toHaveValue("admin");
    await field(page).fill("finance");
    await page.keyboard.press("Enter");
    await expect(folderRow(page, "finance")).toBeVisible();
    // The row re-sorts under the new name, still open and still holding its
    // note. `finance` sorts before `projects`, as `admin` did.
    expect(await treeRows(page)).toEqual(["finance/", "Delta", "projects/", "Alpha"]);
    await expect(noteRow(page, "Delta")).toHaveAttribute("data-target-path", /\/finance\/delta\.md$/);
  });

  test("the menu item is the same verb", async ({ page }) => {
    await folderRow(page, "admin").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename Folder…" }).click();
    await field(page).fill("finance");
    await page.keyboard.press("Enter");
    await expect(folderRow(page, "finance")).toBeVisible();
  });

  test("a nested folder keeps its parent: only the last segment is the name", async ({ page }) => {
    await folderRow(page, "projects").click();
    await folderRow(page, "api").click();
    await page.keyboard.press("r");
    await expect(field(page)).toHaveValue("api"); // not "projects/api"
    await field(page).fill("http");
    await page.keyboard.press("Enter");
    await expect(folderRow(page, "http")).toHaveAttribute("data-target-folder", "projects/http");
    await expect(noteRow(page, "Gamma")).toHaveAttribute("data-target-path", /\/projects\/http\/gamma\.md$/);
  });

  test("the folders that were open stay open, under the new name", async ({ page }) => {
    // A rename changes a folder's name, not whether it is open. The open set is
    // keyed by path, so notes/expansion.ts folderRenamed rewrites every entry
    // under the old path. Without that the renamed folder and everything under
    // it would match nothing in the open set and come back collapsed.
    await folderRow(page, "projects").click();
    await folderRow(page, "api").click();
    expect(await treeRows(page)).toEqual(["admin/", "projects/", "projects/api/", "Gamma", "Beta", "Alpha"]);
    await folderRow(page, "projects").first().focus();
    await page.keyboard.press("r");
    await field(page).fill("work");
    await page.keyboard.press("Enter");
    expect(await treeRows(page)).toEqual(["admin/", "work/", "work/api/", "Gamma", "Beta", "Alpha"]);
  });

  test("the open note's tab follows every note under the folder", async ({ page }) => {
    // A rename leaves every docId untouched, the same as a move does
    // (notes/actions.ts renameFolderTo). The tab keeps the doc it had and the
    // buffer is never reloaded, so the text on screen is the text from before.
    // Only the path the doc is aimed at changes (notes/store.ts retargetDoc).
    await folderRow(page, "projects").click();
    await noteRow(page, "Beta").click();
    await expect(page.locator(".cm-content").first()).toContainText("beta body");
    await folderRow(page, "projects").first().focus();
    await page.keyboard.press("r");
    await field(page).fill("work");
    await page.keyboard.press("Enter");
    await expect(noteRow(page, "Beta")).toHaveAttribute("data-target-path", /\/work\/beta\.md$/);
    await expect(page.locator(".cm-content").first()).toContainText("beta body");
  });

  test("focus lands back on the row, so the keyboard never leaves the list", async ({ page }) => {
    // A folder row's id is `dir:` plus its path (notes/folders.ts
    // folderRowId), so a rename replaces the row rather than relabelling it.
    // Without the refocus the roving tabindex would have nothing left to move
    // from (R5).
    await folderRow(page, "admin").click();
    await page.keyboard.press("r");
    await field(page).fill("finance");
    await page.keyboard.press("Enter");
    await expect.poll(() => focusedRowKey(page)).toBe("dir:finance");
  });

  test("Escape abandons the field and renames nothing", async ({ page }) => {
    await folderRow(page, "admin").click();
    await page.keyboard.press("r");
    await field(page).fill("finance");
    await page.keyboard.press("Escape");
    await expect(field(page)).toHaveCount(0);
    await expect(folderRow(page, "admin")).toBeVisible();
  });

  test("keys typed in the field are typing, never row verbs", async ({ page }) => {
    await folderRow(page, "admin").click();
    await page.keyboard.press("r");
    // On a focused row `/` opens the scoped search, `r` starts a rename, and
    // Enter is the row's disclosure (interactions.md R6 covers Enter and `r`;
    // §3's folder row grants `/`). In the field `/` and `r` are two
    // characters, and Enter commits the rename. ArrowRight comes first because
    // the field selects all of its text on mount (components/RenameField.tsx),
    // and the arrow puts the caret at the end.
    await field(page).press("ArrowRight");
    await field(page).press("/");
    await field(page).press("r");
    await expect(page.getByTestId("overlay-scope")).toHaveCount(0);
    await expect(field(page)).toHaveValue("admin/r");
  });

  test("a name another folder already answers to is refused, and says so", async ({ page }) => {
    await folderRow(page, "admin").click();
    await page.keyboard.press("r");
    await field(page).fill("projects");
    await page.keyboard.press("Enter");
    await expect(page.getByText(/already a folder called/)).toBeVisible();
    expect(await treeRows(page)).toContain("admin/");
  });
});

test.describe("where a note lives, once the list is flat", () => {
  test("quick-open names the folder beside the title", async ({ page }) => {
    // A sidebar row shows which folder a note is in by sitting inside that
    // folder's disclosure. The ⌘P list is flat, with no nesting to show it, and
    // two notes may share a title, so the row carries a folder label
    // (notes/FolderLabel.tsx).
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
    // The pill is on screen before a character is typed, so a scoped search
    // that finds nothing does not read as a workspace that holds nothing
    // (commands/Overlay.tsx).
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
    // The scope belongs to the overlay rather than to one of its modes
    // (commands/Overlay.tsx). Switching modes with the chips keeps it, the same
    // way the chips keep the typed query.
    await folderRow(page, "projects").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Search in Folder" }).click();
    // `exact` is needed here because a role name matches as a substring by
    // default, and the connection bar is a button whose name begins "Notes on"
    // (interactions.md §4-1).
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(page.getByTestId("overlay-scope")).toHaveText("projects");
    await expect(page.getByTestId("overlay-list")).not.toContainText("Alpha");
    // A click anywhere on the pill removes the scope, and the list widens.
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
    // The scope is kept, not dropped: crossing back to Text shows the pill and
    // its narrowed rows again.
    await page.getByRole("button", { name: "Text" }).click();
    await expect(page.getByTestId("overlay-scope")).toHaveText("projects");
  });
});

test.describe("the folders a relaunch reopens", () => {
  // No unit test reaches this path. Opening a folder changes no AppState, so
  // it reaches the debounced layout save only through a subscription
  // (App.tsx). A harness boot always passes a null layout, so
  // workspace/persist.test.ts covers what a relaunch makes of the saved file.
  const savedFolders = (page: Page) =>
    page.evaluate(() => {
      const text = window.__harness.layout();
      if (text === null) return null;
      const saved = JSON.parse(text) as { workspaces: Array<{ expanded: string[] }> };
      return saved.workspaces.flatMap((w) => w.expanded);
    });

  test("a folder you open is written into the layout, and closing it takes it back out", async ({ page }) => {
    await folderRow(page, "projects").click();
    await expect.poll(() => savedFolders(page)).toEqual(["projects"]);

    // A nested folder is saved by its full path, alongside its parent. Both
    // entries are needed to reopen the subtree: `projects` on its own would
    // leave `projects/api` closed.
    await folderRow(page, "api").click();
    await expect.poll(() => savedFolders(page)).toEqual(["projects", "projects/api"]);

    // Collapsing takes the child with it (folders.ts expandedWithout), and the
    // saved file drops both entries rather than keeping the child open.
    await folderRow(page, "projects").first().click();
    await expect.poll(() => savedFolders(page)).toEqual([]);
  });
});

test.describe("deleting a folder", () => {
  // Deleting a folder deletes the notes in it. These specs check that the
  // right ones went: the folder's own, at every depth, and nothing beside it.
  // The dialog's wording is checked here too, since it names the count and says
  // the notes in the folders inside come with them (NoteBrowser.tsx).
  const dialog = (page: Page) => page.getByRole("alertdialog");

  test("`d` asks first, naming the count a collapsed row cannot show", async ({ page }) => {
    await folderRow(page, "projects").first().click(); // focuses it, and opens it
    await folderRow(page, "projects").first().click(); // closed again: its note rows are gone
    await page.keyboard.press("d");
    await expect(dialog(page)).toContainText("Delete “projects”?");
    // Beta and Gamma. Gamma sits a level further down, in projects/api, and
    // the dialog counts it because it counts notes at every depth
    // (shared/folders.ts notesUnder).
    await expect(dialog(page)).toContainText("Its 2 notes move to the Trash");
  });

  test("confirming takes every note under it, however deep, and leaves the rest", async ({ page }) => {
    await folderRow(page, "projects").click();
    await page.keyboard.press("d");
    await page.getByRole("button", { name: "Delete Folder" }).click();
    // Both folder rows go. The browser draws a folder because a note is in it
    // (notes/folders.ts), and no note is left under `projects` or
    // `projects/api`.
    await expect.poll(() => treeRows(page)).toEqual(["admin/", "Alpha"]);
    await expect(noteRow(page, "Delta")).toBeHidden(); // still in admin/, still collapsed
    await expect(noteRow(page, "Alpha")).toBeVisible();
  });

  test("cancelling changes nothing", async ({ page }) => {
    await folderRow(page, "projects").click();
    await page.keyboard.press("d");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await treeRows(page)).toEqual(["admin/", "projects/", "projects/api/", "Beta", "Alpha"]);
  });

  test("Undo brings the whole folder back", async ({ page }) => {
    await folderRow(page, "projects").click();
    await page.keyboard.press("d");
    await page.getByRole("button", { name: "Delete Folder" }).click();
    await expect(page.getByText("Deleted 2 notes in “projects”")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    // One click brings back both notes. The strip holds the list of trashed
    // paths, and Undo runs the same restore over each one (NoteBrowser.tsx
    // undoAll). Where each note lands depends on the trash mirroring the
    // workspace's folders. The harness's flat trash does not model that, so
    // notes.fs.test.ts covers it against a real filesystem.
    await expect(noteRow(page, "Beta")).toBeVisible();
    await expect(noteRow(page, "Gamma")).toBeVisible();
  });

  test("the menu item is the same verb", async ({ page }) => {
    await folderRow(page, "admin").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete Folder…" }).click();
    await expect(dialog(page)).toContainText("Its 1 note moves to the Trash");
    await page.getByRole("button", { name: "Delete Folder" }).click();
    await expect.poll(() => treeRows(page)).toEqual(["projects/", "Alpha"]);
  });
});
