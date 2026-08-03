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

// --- nothing appears under a finger (interactions.md §1a) --------------------
//
// iOS sends a synthetic mousemove ahead of the click of every tap, and WebKit
// WITHHOLDS that click if the mousemove changed the rendering: the tap is spent
// painting a hover nobody can see the point of, and it takes a second one to
// act. Switching notes on a phone cost two taps for exactly this reason — the
// tab strip's close ✕ fades in on `group-hover`.
//
// So the claim under test is not "the tap works" (it does here either way:
// Playwright's WebKit is the engine, not iOS's UI process, and nothing
// withholds anything). It is the CAUSE: on a client that reports `hover: none`,
// no hover style may apply and no hover-revealed control may exist. This
// project reports it — the iPhone 14 descriptor carries the coarse pointer —
// which is what lets a harness stand in for the behavior it cannot reproduce.
test.describe("a tap changes nothing but what it acts on", () => {
  test("hover styles do not apply where there is no hover", async ({ page }) => {
    expect(
      await page.evaluate(() => matchMedia("(hover: none)").matches),
    ).toBe(true);
    // The tab strip's ✕ is the one that cost the taps. Absent, not transparent:
    // an invisible button still takes every tap that lands on it, which on a
    // 390-point strip is a close target at the end of every tab.
    const tab = page.locator("[data-tab]").first();
    await expect(tab).toBeVisible();
    await expect(tab.getByRole("button")).toHaveCount(0);
    // And the row that carries the same pattern (Sidebar.tsx).
    await openSidebar(page);
    const ws = page.locator('[data-target-kind="workspace"]').first();
    await expect(ws.getByRole("button")).toHaveCount(0);
  });

  test("the hover WebKit sends ahead of the click paints nothing", async ({ page }) => {
    // The mechanism, driven for real: `hover()` moves the mouse, which is what
    // sets `:hover` — a dispatched mouseover would not, and a spec that faked
    // one would pass whether or not the gate existed. Under
    // `hoverOnlyWhenSupported` every `hover:` rule sits inside
    // `@media (hover: hover)`, so on this client there is nothing for WebKit's
    // observer to notice and the click that follows lands.
    // An INACTIVE tab: `hover:bg-background/60` is on that branch only, and the
    // active one has a background of its own with no hover rule to gate.
    await openSidebar(page);
    await noteRow(page, "Beta").tap();
    const tab = page.locator("[data-tab]").first();
    await expect(tab).not.toHaveText(/Beta/);
    const bg = () => tab.evaluate((el) => getComputedStyle(el).backgroundColor);
    const before = await bg();
    await tab.hover();
    expect(await bg()).toBe(before);
  });

  test("one tap on a tab shows that tab's note", async ({ page }) => {
    await openSidebar(page);
    await noteRow(page, "Beta").tap();
    await openSidebar(page);
    await noteRow(page, "Gamma").tap();
    await expect(page.locator(".cm-content").first()).toContainText("gamma body");
    // One tap, and the note behind it changed. This is the user-visible half of
    // the two above; on a device it is the half that was broken.
    await page.locator("[data-tab]", { hasText: "Beta" }).tap();
    await expect(page.locator(".cm-content").first()).toContainText("beta body");
  });
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

// --- the rest of v1, on a phone (ios.md §8, phase 6) -------------------------
//
// Search, tags, backlinks, the outline, daily notes and unlocking all existed
// before this phase; what did not exist was any proof they are REACHABLE with a
// finger. The desktop suite drives every one of them from a chord, and the
// phone specs above drive the palette with `page.keyboard` — which is a
// keyboard, and the one thing an iPhone does not have while a note is open.
// These tap.

test.describe("the v1 features, by tap", () => {
  // Every panel is the right-hand drawer here (§9), so they take turns rather
  // than stacking, and the header's own control is the way to each.
  const face = (page: Page, name: RegExp) =>
    page.getByRole("button", { name }).tap();

  test("a search result opens the note it names, at its line", async ({
    page,
  }) => {
    // The tap that matters. Enter picks the ACTIVE row and would pass even if
    // nothing were clickable; a phone has no Enter, so the row itself has to be
    // a target. It regressed once for a reason no unit test could see: the
    // software keyboard scrolled the whole page between the touch and the
    // click, so the click landed on whatever slid under the finger (ios.md §7).
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type("#gamma body");
    await page.getByText("gamma body").last().tap();
    await expect(page.locator(".cm-content").first()).toContainText(
      "gamma body",
    );
  });

  test("the tags panel is a drawer, and a tag drills into the notes bearing it", async ({
    page,
  }) => {
    // A tagged note, made the way a phone makes one: the tree's own New Note
    // button, since ⌘N is a chord. The harness's only tagged fixture is the
    // LOCKED one, whose body is withheld — the rule working, not a gap
    // (locking.md §8) — so the tag has to be written here. Waiting for the row
    // is waiting for the SAVE: the directory is a scan of what is on disk.
    await openSidebar(page);
    // The tree's own, not the pane's: both say New Note, and the pane's is the
    // one a phone cannot see while the drawer is over it.
    await drawer(page).getByRole("button", { name: /New Note/ }).tap();
    await page.keyboard.type("# Shipping\n\nrolling out #canary today");
    // Reopened, because New Note put the drawer away with it (§9) — and the row
    // is what says the note reached disk, which is what the directory scans.
    await openSidebar(page);
    await expect(noteRow(page, "Shipping")).toBeVisible();
    await face(page, /Toggle Tags/);
    await expect(drawer(page)).toBeVisible();
    await page.locator('[data-target-kind="tag"]', { hasText: "canary" }).tap();
    // The drill-in replaces the directory in the same drawer: still one panel,
    // which is what §9's "two drawers never stack" means for a panel with two
    // faces of its own.
    await expect(drawer(page)).toHaveCount(1);
    await expect(page.locator('[data-target-kind="tagnote"]')).toHaveCount(1);
  });

  test("backlinks and the outline take turns in the one drawer", async ({
    page,
  }) => {
    await face(page, /Toggle Backlinks/);
    await expect(drawer(page)).toContainText("Backlinks");
    await face(page, /Toggle Outline/);
    await expect(drawer(page)).toContainText("Outline");
    await expect(drawer(page)).toHaveCount(1);
  });

  test("the tree drawer and a panel drawer never share the screen", async ({
    page,
  }) => {
    await openSidebar(page);
    await face(page, /Toggle Tags/);
    await expect(drawer(page)).toHaveCount(1);
    await expect(noteRow(page, "Alpha")).toHaveCount(0);
  });

  test("a locked note unlocks from its own placeholder, with no chord in reach", async ({
    page,
  }) => {
    // ⌘L is the desktop's way in and the placeholder's button is the phone's.
    // The passphrase field is the other thing this proves: it is the one input
    // on a phone that the accessory bar must NOT decorate, which the shell
    // enforces (ios.md §7) and which only the device can show.
    // No navigation needed: the harness opens on the locked note, which is also
    // the phone's own first-run shape — a client that restores last session's
    // tab can restore a sealed one (ios.md §10).
    await page.getByRole("button", { name: /Unlock Notes/ }).tap();
    const dialog = page.locator('[data-testid="vault-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder("Passphrase").fill("letmein");
    await dialog.getByRole("button", { name: "Unlock" }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".cm-content").first()).toContainText(
      "vaulted needle body",
    );
  });

  test("Insert Image… embeds what the device's picker answered", async ({
    page,
  }) => {
    // The phone has no ⌘V and nothing on its pasteboard: the picker is the only
    // way a picture gets into a note there (ios.md §11), so this is not a
    // convenience but the whole of the feature.
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(">insert image");
    await page.keyboard.press("Enter");
    // The rendered widget, not the markdown: the insert parks the caret BELOW
    // the image's line precisely so it renders straight away (editor/images.ts),
    // which means the reference is concealed by the time this looks.
    await expect(page.locator(".ledge-mdimage img")).toHaveCount(1);
  });

  test("a cancelled picker inserts nothing", async ({ page }) => {
    await page.goto("/harness.html?pick=cancel");
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(">insert image");
    await page.keyboard.press("Enter");
    await expect(page.locator(".ledge-mdimage")).toHaveCount(0);
    await expect(page.locator(".cm-content").first()).not.toContainText(
      ".ledge-assets/",
    );
  });
});

// --- what a phone does NOT have (ios.md §8) ----------------------------------
//
// The cut is only real if the verbs are ABSENT. A palette that lists Toggle
// Terminal and answers with an error strip teaches the user that the palette
// lies, and §8 says so in as many words about Attach Folder.
//
// `?shell=ios` is the harness pretending to be the Swift shell rather than the
// Electrobun one (harness.tsx): same view, same notes, a different answer to
// what this DEVICE can do. Without it these same rows are present, which is the
// point — the desktop keeps every one of them.

test.describe("the iOS client, and what it does not have", () => {
  const palette = async (page: Page, query: string) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(`>${query}`);
  };

  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(
      page.getByRole("button", { name: /Toggle Sidebar/ }),
    ).toBeVisible();
  });

  test("no terminal: not in the chrome, not in the palette", async ({
    page,
  }) => {
    await expect(
      page.getByRole("button", { name: /Toggle Terminal/ }),
    ).toHaveCount(0);
    await palette(page, "terminal");
    await expect(page.getByText("Toggle Terminal")).toHaveCount(0);
  });

  test("no folder verbs, because the server has nobody at it to pick one", async ({
    page,
  }) => {
    // A different reason from the terminal's and a different flag: this one is
    // the SERVER saying it is headless (workspaceList folderDialog), so a Mac
    // pointed at a VPS loses these two as well.
    await palette(page, "folder");
    await expect(page.getByText("Attach Folder as Workspace…")).toHaveCount(0);
    await expect(page.getByText("Move Workspace Folder…")).toHaveCount(0);
  });

  test("a phone keeps its own list of servers, and adds to it here", async ({ page }) => {
    // The native pairing screen is how the FIRST server gets a pin (ios.md §4),
    // and every one after it is added from this dialog like a Mac's. What
    // differs is which key authenticates: a phone has exactly one, in the
    // Secure Enclave, so the form shows the line to install on the new server
    // rather than asking for a path to a file that cannot exist.
    await palette(page, "notes on");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Connections" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("option")).toHaveCount(2);

    await dialog.getByRole("button", { name: "Add Server…" }).tap();
    await expect(dialog).toContainText("authorized_keys");
    await expect(dialog.getByText(/^restrict,command=/)).toBeVisible();
    await expect(dialog.getByLabel(/^Key/)).toHaveCount(0);

    await dialog.getByLabel("Name").fill("Studio");
    await dialog.getByLabel("SSH destination").fill("dev@studio");
    await dialog.getByRole("button", { name: "Continue" }).tap();
    await expect(dialog.getByText("SHA256:harness+fake+key")).toBeVisible();
    await dialog.getByRole("button", { name: "It Matches, Add" }).tap();
    await expect(dialog.getByRole("option")).toHaveCount(3);
  });

  test("editing and removing a server are taps, not a hover and a bare key", async ({ page }) => {
    // ⌫ on a focused row has no touch form and does not get one
    // (interactions.md §1a), so both verbs are controls that are there at rest.
    await palette(page, "notes on");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Connections" });

    await dialog.getByRole("button", { name: "Edit Pi" }).tap();
    await dialog.getByLabel("Name").fill("Shed");
    await dialog.getByRole("button", { name: "Save" }).tap();
    await expect(dialog.getByRole("option").nth(1)).toHaveText(/Shed/);

    await dialog.getByRole("button", { name: "Remove Shed" }).tap();
    await expect(dialog.getByRole("option")).toHaveCount(1);
  });

  test("the manual is not a text field: tapping it raises no keyboard", async ({
    page,
  }) => {
    // The read-only editor stays focusable on a Mac on purpose — find, ⌘C and
    // ⌘↩ on the manual's own runnable blocks all need it. A phone has none of
    // those chords and does have a keyboard that would cover half the page it
    // just opened, so there the contentDOM stops being editable at all.
    await page.getByRole("button", { name: "Documentation", exact: true }).tap();
    const content = page.locator(".cm-content").first();
    await expect(content).toHaveAttribute("contenteditable", "false");
    await content.tap();
    await expect(content).not.toBeFocused();
    // Still a document: selecting and copying it is iOS's own gesture on any
    // uneditable text, and every line is there to select.
    await expect(content).toContainText("Getting Started");
  });

  test("the help button closes the manual, which on a phone is the only way out", async ({
    page,
  }) => {
    // The strip is the documented way back and it lives inside the drawer the
    // manual is covering; ⌘1 is a chord. So the button that opened it has to
    // close it, or the manual is a room with no door (interactions.md §1a).
    const help = page.getByRole("button", { name: "Documentation", exact: true });
    await help.tap();
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toBeVisible();
    await help.tap();
    // Back on the notes, and nothing was closed: the manual keeps its tabs, so
    // the tap that brings it back lands where it was left.
    await expect(page.locator("[data-tab]", { hasText: "Getting Started" })).toHaveCount(0);
    // Back on the workspace it opened from, which the harness starts on: the
    // locked note and its placeholder.
    await expect(page.locator('[data-testid="locked-face"]')).toBeVisible();
  });

  test("the verbs a phone does have are all still there", async ({ page }) => {
    // The other half of the claim, and the one that catches a gate written too
    // wide: cutting the terminal must not cut the editor with it.
    await palette(page, "");
    // Scoped to the overlay: two of these titles are also live buttons on the
    // screen behind it, and what is under test is what the PALETTE offers.
    const list = page.locator("div.fixed.inset-0.z-50");
    for (const title of [
      "Insert Image…",
      "Toggle Tags",
      "Toggle Backlinks",
      "Toggle Outline",
      "Open Today's Daily Note",
      "Unlock Notes…",
      "New Note",
    ]) {
      await expect(list.getByText(title, { exact: true })).toHaveCount(1);
    }
  });
});

// --- the phone runs blocks, and still has no drawer --------------------------
//
// §8's cut lifted in two steps (ios.md §14), and this is where it stopped: a
// client that runs blocks inline and has no terminal. Not a transitional state
// to be tolerated but where a phone stays — inline output is a panel under the
// fence, and a drawer is a second arrangement with a keyboard grammar (Ctrl-`,
// Escape) a phone cannot type.
//
// The same `?shell=ios` as the describe above, which is the point: one client,
// asserted from both directions.
test.describe("the phone runs blocks, without a terminal", () => {
  const palette = async (page: Page, query: string) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(`>${query}`);
  };
  const overlay = (page: Page) => page.locator("div.fixed.inset-0.z-50");

  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(
      page.getByRole("button", { name: /Toggle Sidebar/ }),
    ).toBeVisible();
  });

  test("a runnable fence keeps the ▶ and loses the terminal beside it", async ({
    page,
  }) => {
    // The pair is two controls, not one widget: this is the assertion that
    // stops a client which runs blocks from drawing the button that fills a
    // drawer it does not have.
    await page.keyboard.press("Meta+n");
    await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText("```sh\npwd\n```\n");
    await expect(page.locator('[data-act="run"]')).toHaveCount(1);
    await expect(page.locator('[data-act="term"]')).toHaveCount(0);
  });

  test("the palette offers the inline run, and the note shell it spawns", async ({
    page,
  }) => {
    await palette(page, "run block");
    await expect(overlay(page).getByText("Run Block Inline", { exact: true })).toHaveCount(1);
    await expect(
      overlay(page).getByText("Run Block in Terminal", { exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Back with the runs, because an inline run spawns the shell this kills.
    await palette(page, "restart");
    await expect(overlay(page).getByText("Restart Note Shell", { exact: true })).toHaveCount(1);
  });

  test("the drawer stays cut: not in the chrome, not in the palette", async ({
    page,
  }) => {
    await expect(
      page.getByRole("button", { name: /Toggle Terminal/ }),
    ).toHaveCount(0);
    await palette(page, "terminal");
    await expect(overlay(page).getByText("Toggle Terminal", { exact: true })).toHaveCount(0);
  });
});

// --- the two questions asked before a command runs --------------------------
//
// interactions.md §4a and §4b, on a client with no keyboard. Both were designed
// around one: the picker is "⌘↩ then Enter to repeat, an arrow to go elsewhere",
// and both dismiss on an Escape a software keyboard does not have. A finger
// keeps the ordering and loses the whole economy — every row is one tap, so the
// preselection stops being cheaper than the alternative and the only things left
// holding the answer apart are how big the targets are and what they say.
//
// So these specs assert three things the desktop suite cannot: that a finger can
// open both, that the targets are 44 points, and that the last pick is marked
// rather than merely focused. What each dialog MEANS is host-picker.spec.ts's
// and run-confirm.spec.ts's, and is not restated here.
test.describe("choosing a machine, and confirming a run, by finger", () => {
  // A note with a runnable block, written with the keyboard: composing a note is
  // setup, and every VERB below is a tap. `uptime` because the confirmation
  // shows the code, and a spec should be able to point at the line it shows.
  const NOTE = (frontmatter: string) =>
    `---\n${frontmatter}\n---\n# Untitled\n\n\`\`\`sh\nuptime\n\`\`\`\n`;

  async function blockNote(page: Page, frontmatter: string): Promise<void> {
    await page.keyboard.press("Meta+n");
    await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText(NOTE(frontmatter));
    await expect(page.locator(".cm-line", { hasText: "uptime" })).toBeVisible();
  }

  // How a finger asks for a run: one tap on the ▶, which is lit without being
  // asked on a client with no hover to ask with (index.css, §1a). Writing these
  // specs is what found it costing two.
  async function tapRun(page: Page): Promise<void> {
    await page.locator('[data-act="run"]').tap();
  }

  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(
      page.getByRole("button", { name: /Toggle Sidebar/ }),
    ).toBeVisible();
  });

  test("the picker opens from a fence a finger tapped, and the row is the answer", async ({
    page,
  }) => {
    await blockNote(page, "host: web1 db2");
    await tapRun(page);

    // The dialog RENDERS, which is the assumption this file exists to stop
    // making, and nothing has run behind it.
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);

    await page.getByRole("menuitem", { name: "db2" }).tap();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
    expect((await page.evaluate(() => window.__harness.inlineRuns()))[0].host).toBe("db2");
  });

  test("both machines are 44-point targets, adjacent in one list", async ({
    page,
  }) => {
    await blockNote(page, "host: web1 db2");
    await tapRun(page);
    const rows = page.getByRole("menuitem");
    await expect(rows).toHaveCount(2);
    // The number is the platform's floor for a finger. It matters more here than
    // in any other menu in the app: the two rows are `staging` and `prod`, they
    // sit against each other, and the cost of hitting the wrong one is a command
    // on the wrong machine.
    for (const h of await rows.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    )) {
      expect(h).toBeGreaterThanOrEqual(44);
    }
  });

  test("the last machine is marked, not merely focused", async ({ page }) => {
    await blockNote(page, "host: web1 db2");
    await tapRun(page);
    // Nothing marked yet: the session has no last pick to preselect.
    await expect(page.locator("[data-preferred]")).toHaveCount(0);
    await page.getByRole("menuitem", { name: "db2" }).tap();
    await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);

    // One live run per block gates re-running, and PTYs are inert here, so the
    // panel has to go before the block is free again.
    await page.getByTitle("Dismiss").tap();
    await tapRun(page);
    const marked = page
      .getByRole("menuitem")
      .filter({ has: page.locator("[data-preferred]") });
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText("db2");
  });

  test("a tap outside is the Escape a phone has not got, and it runs nothing", async ({
    page,
  }) => {
    await blockNote(page, "host: web1 db2");
    await tapRun(page);
    const menu = (await page.getByRole("menu").boundingBox())!;
    const below = menu.y + menu.height + 80;
    expect(below).toBeLessThan(page.viewportSize()!.height); // the tap lands on screen
    await page.touchscreen.tap(30, below);
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);
  });

  test("the confirmation's two buttons are 44 points and not against each other", async ({
    page,
  }) => {
    await blockNote(page, "confirm: true");
    await tapRun(page);
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    // §4b: the code is shown, because the fence body is the truth about what is
    // about to run.
    await expect(dialog).toContainText("uptime");

    const boxes = await dialog.getByRole("button").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, height: r.height };
      }),
    );
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(44);
    // Cancel and the button that runs `rm -rf` are the pair on screen; a
    // desktop's 8 points between them is a comfortable click and a bad tap.
    const [cancel, run] = boxes as [(typeof boxes)[0], (typeof boxes)[0]];
    expect(run.left - cancel.right).toBeGreaterThanOrEqual(16);
  });

  test("Cancel is a tap, and so is Run, and only one of them runs anything", async ({
    page,
  }) => {
    await blockNote(page, "confirm: true");
    await tapRun(page);
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).tap();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);

    // Nothing remembered: §4b's always-ask survives losing the keyboard.
    await tapRun(page);
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Run", exact: true })
      .tap();
    await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
  });

  test("the machine is chosen first, then named in the question, with no chord in it", async ({
    page,
  }) => {
    await blockNote(page, "host: web1 db2\nconfirm: true");
    await tapRun(page);
    await page.getByRole("menuitem", { name: "db2" }).tap();

    // §4b's ordering, driven entirely by taps: the picker, then a question that
    // can name what was picked.
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("db2");
    expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(0);
    await dialog.getByRole("button", { name: "Run", exact: true }).tap();
    await expect.poll(() => page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
    expect((await page.evaluate(() => window.__harness.inlineRuns()))[0].host).toBe("db2");
  });
});

// --- getting the keyboard back off a run ------------------------------------
//
// interactions.md §6a: a run takes the keyboard when it first speaks, so a
// `sudo` password goes to sudo instead of into the note, and the way back is
// ⌘Escape or two Escapes. A phone has no ⌘ and its software keyboard has no
// Escape at all, which leaves one exit inherited by accident — tapping the
// prose — and a full-screen program is exactly what takes that away: it pins
// the panel to 24 rows, and 24 rows with the keyboard up is the whole screen.
//
// So the panel carries the exit as a control on this client. The desktop half
// (who claims the keyboard, and when the claim lapses) is inline-focus.spec.ts's
// and is not restated here.
test.describe("giving the keyboard back, with no key to press", () => {
  const IN_TERMINAL = () => !!document.activeElement?.closest(".xterm");
  const IN_EDITOR = () => !!document.activeElement?.classList.contains("cm-content");

  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(
      page.getByRole("button", { name: /Toggle Sidebar/ }),
    ).toBeVisible();
  });

  // A block run by finger, then made to speak. PTYs are inert in the harness,
  // so `runOutput` pushes the first byte the way Bun's runEvent would — which
  // is the moment the run claims the keyboard, and the only thing this needs.
  async function talkingRun(page: Page): Promise<void> {
    await page.keyboard.press("Meta+n");
    await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText("# Untitled\n\n```sh\nsudo ls\n```\n");
    await page.locator('[data-act="run"]').tap();
    await expect(page.locator(".ledge-output")).toBeVisible();
    const runs = await page.evaluate(() => window.__harness.inlineRuns());
    const id = runs[runs.length - 1]!.id;
    await page.evaluate((runId) => window.__harness.runOutput(runId, "Password:"), id);
    await expect.poll(() => page.evaluate(IN_TERMINAL)).toBe(true);
  }

  test("the panel offers a control where a Mac names two keys", async ({ page }) => {
    await talkingRun(page);
    // The disclosure is the button, not a line of text beside one: "Back to
    // note" only means anything to someone who is not in the note, and it is
    // also the way back. The header has room for one of the two at 390 points,
    // and the pair that interrupts the run has to fit beside it.
    await expect(page.locator(".ledge-focus-hint")).toBeHidden();
    await expect(page.locator(".ledge-focus-key")).toBeHidden();
    await expect(page.locator(".ledge-term-leave")).toBeVisible();
  });

  test("tapping it hands the keyboard to the note, and does not stop the run", async ({
    page,
  }) => {
    await talkingRun(page);
    await page.locator(".ledge-term-leave").tap();

    await expect.poll(() => page.evaluate(IN_EDITOR)).toBe(true);
    // Leaving is a focus move and nothing else: the panel is still there, still
    // running, and its output is still on screen. The ✕ is the one that
    // interrupts.
    await expect(page.locator(".ledge-output")).toBeVisible();
    await expect(page.locator(".ledge-status")).toHaveText("Running");
    // And with the keyboard back in the note, it goes in the note.
    await page.keyboard.type("still writing");
    await expect(page.locator(".cm-line", { hasText: "still writing" })).toBeVisible();
  });

  test("it is only there while the run holds the keyboard", async ({ page }) => {
    await talkingRun(page);
    await expect(page.locator(".ledge-term-leave")).toBeVisible();
    await page.locator(".ledge-term-leave").tap();
    // Nothing to give back, so nothing offering to: the control follows focus
    // rather than the run, which is what makes it impossible to leave stale.
    await expect(page.locator(".ledge-term-leave")).toBeHidden();
  });

  test("the panel it sits in fits the screen", async ({ page }) => {
    await talkingRun(page);
    // A control off the right edge is not a control, and the panel had no width
    // of its own to keep it on: it fills the editor's content, the content is as
    // wide as its widest thing, and an xterm opening at 80 columns WAS that
    // thing — 605 points inside a 370-point editor, with the re-fit measuring
    // the overflow it caused and agreeing with it. Harmless on a Mac, where 605
    // fits; here it put the whole header off the screen.
    const panel = (await page.locator(".ledge-output").boundingBox())!;
    expect(panel.x + panel.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    // Sideways scroll is the symptom, and the note is what does it.
    const scroll = await page.locator(".cm-scroller").evaluate((el) => ({
      w: el.clientWidth,
      s: el.scrollWidth,
    }));
    expect(scroll.s).toBeLessThanOrEqual(scroll.w);
  });

  test("all three of the header's controls are 44 points, and separated", async ({ page }) => {
    await talkingRun(page);
    const leave = (await page.locator(".ledge-term-leave").boundingBox())!;
    expect(leave.height).toBeGreaterThanOrEqual(44);

    // Its neighbour is the pair drawn in the body overlay, and the FAR one of
    // the two dismisses a still-running block by interrupting it. Same argument
    // as the confirmation's Cancel/Run pair above: adjacent alternatives where
    // the miss does not land on nothing (interactions.md §1a). Copy is what
    // sits between, so the miss that costs anything needs two of them.
    const pair = page.locator(".ledge-close-wrap button");
    const copy = (await pair.first().boundingBox())!;
    const dismiss = (await pair.last().boundingBox())!;
    for (const b of [copy, dismiss]) {
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }
    expect(copy.x - (leave.x + leave.width)).toBeGreaterThanOrEqual(16);
    expect(dismiss.x - (copy.x + copy.width)).toBeGreaterThanOrEqual(8);

    // And the header holds them: the reserved width in it does not shrink, or
    // the pair ends up drawn over the button that gives the keyboard back.
    expect(leave.x + leave.width).toBeLessThanOrEqual(copy.x);
  });

  test("the way back in is a tap on the terminal", async ({ page }) => {
    await talkingRun(page);
    await page.locator(".ledge-term-leave").tap();
    await expect.poll(() => page.evaluate(IN_EDITOR)).toBe(true);

    // The exit has to be reversible or it is a trap: the run is still asking
    // for a password, and answering it must not need the block re-run.
    await page.locator(".xterm-screen").tap();
    await expect.poll(() => page.evaluate(IN_TERMINAL)).toBe(true);
    await expect(page.locator(".ledge-term-leave")).toBeVisible();
  });
});

// --- the block's own chrome, for a finger ------------------------------------
//
// Every runnable fence carries the pair that runs and copies it, and on a
// pointer client the pair is hover-revealed: `opacity: 0` until the pointer or
// the caret is in the block. A phone has neither half of that. What it had
// instead was two taps — one in the block to light the ▶, one on the ▶ — and a
// 22-point target with its neighbour one pixel away.
//
// So on touch the controls are always lit and 44 points, and the card grows a
// lane at its top to hold them. The one control that goes the other way is the
// frontmatter profile chip: it is absent, because its verb is in the palette
// and is note-scoped, which the ▶'s is not (interactions.md §1a).
test.describe("running a block by finger", () => {
  const palette = async (page: Page, query: string) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(`>${query}`);
  };

  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(page.getByRole("button", { name: /Toggle Sidebar/ })).toBeVisible();
  });

  // A note whose caret ends up AFTER the block, which is the state a pointer
  // client draws no controls in: the block is neither hovered nor holding it.
  async function noteWithBlock(page: Page): Promise<void> {
    await page.keyboard.press("Meta+n");
    await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText("# Untitled\n\nprose\n\n```sh\nsudo ls\nsecond line\n```\n");
    await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  }

  test("one tap runs it, with no tap to summon the button first", async ({ page }) => {
    await noteWithBlock(page);
    // Lit without being asked. The class the pointer toggles is still toggled
    // here — WebKit sends a synthetic mousemove ahead of every tap — but it
    // decides nothing on this client, which is the point: nothing about the
    // rendering changes when that mousemove arrives, so WebKit does not
    // withhold the click behind it (interactions.md §1a).
    await expect(page.locator(".ledge-ctl-group")).toHaveCSS("opacity", "1");

    await page.locator('[data-act="run"]').tap();
    await expect(page.locator(".ledge-output")).toBeVisible();
    expect(await page.evaluate(() => window.__harness.inlineRuns())).toHaveLength(1);
  });

  test("the pair is 44 points, and does not cover the code it runs", async ({ page }) => {
    await noteWithBlock(page);
    const buttons = page.locator(".ledge-ctl-group button");
    await expect(buttons).toHaveCount(2); // ▶ and Copy; no drawer on this client
    const run = (await buttons.first().boundingBox())!;
    const copy = (await buttons.last().boundingBox())!;
    for (const b of [run, copy]) {
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }
    expect(copy.x - (run.x + run.width)).toBeGreaterThanOrEqual(8);

    // The card grew a lane for them rather than the group growing over the
    // code: 22 more points of top padding, which is exactly what the group
    // gained, and the group lifted by the same 22. So it still ends where the
    // small one did, at the opening fence.
    const groupEl = page.locator(".ledge-ctl-group");
    const group = (await groupEl.boundingBox())!;
    const card = (await page.locator(".cm-line.ledge-code-top").boundingBox())!;
    const code = (await page.locator(".cm-line", { hasText: "sudo ls" }).boundingBox())!;
    expect(group.y).toBeGreaterThanOrEqual(card.y);
    expect(group.y + group.height).toBeLessThanOrEqual(code.y + 4);

    // And the box a pointer client draws around the pair is not drawn around
    // this one. It is there to separate two small glyphs from the code they
    // float over; here the lane above does that, and the same fill and border
    // around 44-point buttons is a 50-point empty panel with a speck in it.
    await expect(groupEl).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(groupEl).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  });

  test("the note does not scroll sideways to hold them", async ({ page }) => {
    await noteWithBlock(page);
    // The controls are the widest chrome in a card now, and a card is as wide
    // as the note (interactions.md §1a): a group that overflowed would take the
    // whole note sideways with it and put its own ▶ off the screen.
    const scroll = await page.locator(".cm-scroller").evaluate((el) => ({
      w: el.clientWidth,
      s: el.scrollWidth,
    }));
    expect(scroll.s).toBeLessThanOrEqual(scroll.w);
    const group = (await page.locator(".ledge-ctl-group").boundingBox())!;
    expect(group.x + group.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });

  test("the profile chip is not here, and Edit Note Profile… is", async ({ page }) => {
    await page.keyboard.press("Meta+n");
    await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText("---\nprofile: petstore\n---\n# Petstore calls\n");
    await expect(page.locator(".ledge-fm-profile")).toBeVisible();

    // Gone, not faded: an invisible 16-point button still takes every tap that
    // lands on it, and this one sits in the middle of editable text.
    await expect(page.locator('.ledge-ctl-group[data-block="fm"]')).toBeHidden();

    // Both of its desktop paths are a pointer's — the chip, and ⌘-clicking the
    // name — so the palette is the whole of this verb here. It is note-scoped,
    // which is why that is no loss: nothing has to be pointed at first.
    await palette(page, "edit note profile");
    const overlay = page.locator("div.fixed.inset-0.z-50");
    await expect(overlay.getByText("Edit Note Profile…", { exact: true })).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Profile petstore" })).toBeVisible();
  });
});
