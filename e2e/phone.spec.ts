// The phone: the same view at 390x844, with touch and no chords (ios.md §6,
// §13). Two claims are under test. The first is reachability — a phone-sized
// client can reach every verb — spelled out on the two surfaces that carry it:
// the menu a long press opens on any row, and the overlay the chrome's own
// control opens. The second is the arrangement (ios.md §9, phase 5): one pane
// at a time, with the tree covering the editor rather than taking a third of
// its width. Everything the desktop suite asserts about the verbs themselves
// still holds; what a phone changes is how you get to them and what you see
// while you do.
//
// The project is `phone` in playwright.config.ts, and it runs this file only.
import { expect, test, type Locator, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// The drawer itself: the <aside> App renders in place of the sidebar pane.
const drawer = (page: Page) => page.locator("aside.absolute");
const scrim = (page: Page) => page.locator("div.z-30.inset-0");

// The tree is a drawer here and it starts shut, so the header's control is the
// way in — and on a phone it is the ONLY way in, ⌥⌘B being a chord.
async function openSidebar(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Toggle Sidebar/ }).tap();
  await expect(noteRow(page, "Alpha")).toBeVisible();
}

// Polled, not measured once. A width is the one thing here that changes a
// render behind Playwright's back — a viewport change lands in the browser
// before React has re-rendered against it, and a bare `expect(await width)`
// reads the old arrangement and calls it the answer. `expect.poll` retries on
// the suite's own timeout, which is what every other assertion in this file
// already does.
const expectWidth = (locator: Locator, px: number) =>
  expect
    .poll(() => locator.evaluate((el) => el.getBoundingClientRect().width))
    .toBe(px);

// A finger held on a row. Playwright's touchscreen can tap and nothing else,
// so the press is dispatched: pointerdown at the row's middle, then — once the
// menu has had its 500ms to appear — the pointerup and the click WebKit sends
// after every touch, which is the click the row must NOT act on.
async function pressAndHold(row: Locator): Promise<void> {
  const box = await row.boundingBox();
  if (!box) throw new Error("no box to press");
  const at = {
    pointerType: "touch",
    isPrimary: true,
    bubbles: true,
    clientX: Math.round(box.x + box.width / 2),
    clientY: Math.round(box.y + box.height / 2),
  };
  await row.dispatchEvent("pointerdown", at);
  await expect(row.page().getByRole("menu")).toBeVisible();
  await row.dispatchEvent("pointerup", at);
  await row.dispatchEvent("click", at);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  // Not a note row: at this size there are none on screen yet. The chrome is
  // what has loaded, and the toggle below is what puts the tree on screen.
  await expect(
    page.getByRole("button", { name: /Toggle Sidebar/ }),
  ).toBeVisible();
});

// --- the arrangement (ios.md §9) --------------------------------------------

test("the app opens on the note, not on the tree", async ({ page }) => {
  // Phase 2 shipped the desktop arrangement at this size and called it bad:
  // the sidebar took 224 of 390 points and left the editor 161. The tree is a
  // drawer now, and a drawer starts shut.
  await expect(drawer(page)).toHaveCount(0);
  await expect(noteRow(page, "Alpha")).toBeHidden();
  await expectWidth(page.locator("main"), 390);
});

test("the tree covers the editor instead of taking its width", async ({
  page,
}) => {
  await openSidebar(page);
  // 280 of 390, so 110 points of the note stay visible under the scrim — the
  // drawer says what it is covering. And the editor is still the full width,
  // which is the whole difference from the pane: nothing reflowed to make room,
  // so putting the drawer away costs no relayout.
  await expectWidth(drawer(page), 280);
  await expectWidth(page.locator("main"), 390);
  await expect(scrim(page)).toBeVisible();
});

test("a tap on what it covers puts it away", async ({ page }) => {
  await openSidebar(page);
  // Far enough right to land on the scrim rather than the drawer, and low
  // enough to be over the editor: the tap must dismiss and must NOT also land
  // in the note behind it (the click-after-touch trap phase 2 found).
  await page.touchscreen.tap(345, 500);
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator(".cm-content").first()).not.toBeFocused();
});

test("picking a note puts the drawer away with it", async ({ page }) => {
  await openSidebar(page);
  await noteRow(page, "Beta").tap();
  // The drawer's job ended when it was picked from; leaving it up would cover
  // the note it just opened.
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator(".cm-content").first()).toContainText("beta body");
});

test("two drawers never stack", async ({ page }) => {
  await page.getByRole("button", { name: /Outline/ }).tap();
  await expect(drawer(page)).toHaveCount(1);
  // Single-PANE: opening the tree closes the panel rather than laying a second
  // scrim over the first on a 390-point screen.
  await page.getByRole("button", { name: /Toggle Sidebar/ }).tap();
  await expect(drawer(page)).toHaveCount(1);
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await expect(page.getByText("OUTLINE")).toBeHidden();
});

test("the breakpoint is a width, not a device", async ({ page }) => {
  // lib/viewport.ts subscribes to a media query, so this has to survive the
  // window moving across it — the case a Mac reaches by being dragged narrow
  // and a phone reaches by being turned over. Asserting it here rather than by
  // hand because a viewport change is one of the few things a harness can
  // dispatch and a screenshot cannot.
  await openSidebar(page);
  await expectWidth(drawer(page), 280);

  await page.setViewportSize({ width: 1200, height: 844 });
  // Wide: the tree is a pane again, so there is no <aside class="absolute">
  // and no scrim, and the editor gives up width to it rather than sitting
  // underneath.
  await expect(drawer(page)).toHaveCount(0);
  await expect(scrim(page)).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  // Narrow again: crossing IN closes what was open, so the editor is not left
  // behind a scrim the user never asked for.
  await expect(drawer(page)).toHaveCount(0);
  await expectWidth(page.locator("main"), 390);
});

test("the editor refuses iOS's corrections", async ({ page }) => {
  // ios.md §7: an autocorrected fence is a broken one. CodeMirror sets all
  // three on its contentDOM and Ledge adds no contentAttributes entry, so
  // this passes today — it is here to fail the day one is added.
  const content = page.locator(".cm-content").first();
  await expect(content).toHaveAttribute("spellcheck", "false");
  await expect(content).toHaveAttribute("autocorrect", "off");
  await expect(content).toHaveAttribute("autocapitalize", "off");
});

// --- reachability (ios.md §6), all of it from the tree the drawer holds ------

test.describe("with the tree on screen", () => {
  test.beforeEach(async ({ page }) => {
    await openSidebar(page);
  });

  test("a tap focuses the row it lands on: the verbs have a subject again", async ({
    page,
  }) => {
    // R5's roving focus is what every row verb addresses, and a phone has no
    // hover to hint at it beforehand. The tapped row is the focused row.
    await noteRow(page, "Beta").tap();
    await expect(page.locator(".cm-content").first()).toContainText(
      "beta body",
    );
    // Shown on a second tap rather than the first, because the first also
    // navigated and took the drawer — and the row — off the screen with it.
    // Tapping the note that is already open moves nothing, so the ring stays
    // where it can be seen.
    await openSidebar(page);
    await noteRow(page, "Beta").tap();
    await expect(drawer(page)).toHaveCount(1);
    await expect(noteRow(page, "Beta")).toBeFocused();
    // And it stayed on the row: opening a note from a list shows it, while
    // clicking the editor is what says you want to type in it
    // (workspace/PaneTree.tsx). The drawer does not change that rule — which
    // is why a tap that DOES navigate leaves focus on no row at all rather
    // than summoning the software keyboard over the note it just opened.
    await expect(page.locator(".cm-content").first()).not.toBeFocused();
  });

  test("a long press opens the row's menu, and does not also open the note", async ({
    page,
  }) => {
    await noteRow(page, "Alpha").tap();
    const tabs = await page.locator("[data-tab]").count();
    // The tap put the drawer away with the note it opened, and the press is
    // about a row, so the tree has to be back on screen to hold one.
    await openSidebar(page);
    await pressAndHold(noteRow(page, "Gamma"));
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Delete/ })).toBeVisible();
    // The press was a question about Gamma, not an instruction to open it: the
    // click that follows a touch is swallowed, so Alpha is still the note.
    await expect(page.locator("[data-tab]")).toHaveCount(tabs);
    await expect(page.locator(".cm-content").first()).toContainText(
      "alpha body",
    );
    // And the press left the focus ring on the row the menu is about (§6).
    await expect(noteRow(page, "Gamma")).toBeFocused();
  });

  test("the long press is the only way to Copy Path, and it works", async ({
    page,
  }) => {
    // Copy Path has no chord and no palette entry — it acts on a specific row,
    // so the row's menu is its whole home (R2/R6). On a phone that means it
    // exists if and only if the long press does.
    await pressAndHold(noteRow(page, "Beta"));
    await page.getByRole("menuitem", { name: "Copy Path" }).tap();
    expect(await page.evaluate(() => window.__harness.clipboard())).toContain(
      "beta",
    );
  });

  test("Delete runs from the menu, undoably, with no accelerator anywhere near it", async ({
    page,
  }) => {
    await pressAndHold(noteRow(page, "Alpha"));
    await page.getByRole("menuitem", { name: /Delete/ }).tap();
    await expect(noteRow(page, "Alpha")).toHaveCount(0);
    // Reversible destruction offers Undo instead of a prompt (§4), and the strip
    // is a tap target like any other.
    await page.getByRole("button", { name: "Undo" }).tap();
    await expect(noteRow(page, "Alpha")).toBeVisible();
  });

  test("Delete Permanently keeps its confirmation and loses its accelerator", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /^Trash/ }).tap();
    const trashRow = page.locator('[data-target-kind="trash"]').first();
    await pressAndHold(trashRow);
    await page.getByRole("menuitem", { name: /Delete Permanently/ }).tap();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("cannot be undone");
    // §4: focus lands on Cancel, and the phone changes nothing about that.
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Delete Permanently" }).tap();
    await expect(page.locator('[data-target-kind="trash"]')).toHaveCount(0);
  });

  test("a menu opened at the bottom of the screen opens entirely on it", async ({
    page,
  }) => {
    // ios.md §13's second failure: "a row menu that opens off screen". It needs
    // a list long enough to reach the bottom of the phone, which the seeded four
    // notes are not — so seed a screenful and press the last one, where a menu
    // that hangs downward has nowhere to hang.
    await page.evaluate(() => {
      for (let i = 1; i <= 30; i++)
        window.__harness.store.seed("/harness/scratch", `# Zeta ${i}\n`);
      window.__harness.notesChanged("/harness/scratch");
    });
    const rows = page.locator('[data-target-kind="note"]');
    await expect(rows).toHaveCount(34);
    const last = rows.last();
    await last.scrollIntoViewIfNeeded();
    const rowBox = await last.boundingBox();
    const view = page.viewportSize()!;
    expect(rowBox!.y).toBeGreaterThan(view.height * 0.75); // the case is real

    await pressAndHold(last);
    const menu = (await page.getByRole("menu").boundingBox())!;
    expect(menu.y).toBeGreaterThanOrEqual(0);
    expect(menu.y + menu.height).toBeLessThanOrEqual(view.height);
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(view.width);
    // Above the finger, not merely shoved up the screen: the row the menu is
    // about stays visible.
    expect(menu.y + menu.height).toBeLessThanOrEqual(
      rowBox!.y + rowBox!.height,
    );
  });

  test("a workspace row's menu carries its verbs, Rename included", async ({
    page,
  }) => {
    await pressAndHold(page.locator('[data-target-kind="workspace"]').first());
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: "Rename Workspace…" }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Close Workspace" }),
    ).toBeVisible();
    // Double-click is the desktop accelerator for a rename; the menu item is the
    // path R3 already called the discoverable one, and the only one here.
    await menu.getByRole("menuitem", { name: "Rename Workspace…" }).tap();
    // The inline field, not the editor's contenteditable: an <input> in the row.
    await expect(
      page.locator('[data-target-kind="workspace"] input'),
    ).toBeFocused();
  });

  test("a tab is a row too: its menu is where Close Tab lives without ⌘W", async ({
    page,
  }) => {
    await noteRow(page, "Alpha").tap();
    await openSidebar(page); // each tap closes the drawer behind it
    await noteRow(page, "Beta").tap();
    const tabs = page.locator("[data-tab]");
    const open = await tabs.count();
    expect(open).toBeGreaterThan(1);
    await pressAndHold(tabs.first());
    await page.getByRole("menuitem", { name: "Close Tab" }).tap();
    await expect(tabs).toHaveCount(open - 1);
  });

  test("the chrome's control opens quick-open, which is the way to every note", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type("gam");
    await page.keyboard.press("Enter");
    await expect(page.locator(".cm-content").first()).toContainText(
      "gamma body",
    );
  });

  test("and `>` inside it is the way to every command", async ({ page }) => {
    // The chord ⇧⌘P does not exist here. The control opens the overlay and its
    // own placeholder teaches the crossing, which is what keeps one button
    // enough for all three modes.
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await expect(page.getByPlaceholder(/> commands/)).toBeVisible();
    await page.keyboard.type(">toggle sidebar");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Workspaces")).toBeHidden();
  });

  test("a verb that only ever had a chord is reachable from the palette: Split Right", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(">split right");
    await page.keyboard.press("Enter");
    // Two panes on a 390pt screen is a bad idea and a reachable one; what this
    // asserts is the reachability. §9's single-pane rule is about the CHROME —
    // the tree and the panels — and deliberately takes nothing off the registry:
    // a split the user asked for by name is a split they get.
    await expect(page.locator(".cm-editor")).toHaveCount(2);
  });

  test("Empty Trash: confirmed, from the palette, with nothing bound to a key", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(">empty trash");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Empty the trash?");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Empty Trash" }).tap();
    await expect(page.getByRole("button", { name: /^Trash/ })).toHaveCount(0);
  });
});
