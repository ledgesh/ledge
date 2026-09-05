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

// One of the overlay's three mode chips, scoped to the overlay so a command
// named the same thing in a list below cannot answer for it. A prefix match,
// because on a pointer client the chip also prints its sigil.
const chip = (page: Page, name: string) =>
  page.locator("div.fixed.inset-0.z-50").getByRole("button", { name: new RegExp(`^${name}`) });

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

  test("and a chip inside it is the way to every command", async ({ page }) => {
    // The chord ⇧⌘P does not exist here, and neither does the `>` that used to
    // be the only other way across: both sigils are on the iPhone keyboard's
    // THIRD plane (123, then #+=), so crossing cost two plane switches to reach
    // one character and a third tap to get back to letters — to run a verb whose
    // only other home is a chord. One button opens the overlay and three chips
    // are what make it all three modes.
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await chip(page, "Commands").tap();
    await page.keyboard.type("toggle sidebar");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Workspaces")).toBeHidden();
  });

  test("a chip carries the query across, because retyping is what costs here", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type("gam");
    await chip(page, "Text").tap();
    await expect(page.getByPlaceholder("Search inside notes")).toHaveValue("gam");
  });

  test("a title search that finds nothing offers the text search, in one tap", async ({
    page,
  }) => {
    // The one crossing that needs no prior knowledge of a chip, a sigil or a
    // chord: it appears in the list, where the answer was expected to be.
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type("beta body");
    await page.locator("[data-crossing]").tap();
    await expect(page.getByPlaceholder("Search inside notes")).toHaveValue("beta body");
    await expect(page.locator("[data-active]")).toContainText("beta body");
    await page.locator("[data-active]").tap();
    await expect(page.locator(".cm-content").first()).toContainText("beta body");
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

// --- a split is a place you can leave (interactions.md §1a) ------------------
//
// A phone can make a split three ways: `>split right` in the palette, and Split
// Right or Split Down in a tab's menu. For a while it could make one and not
// unmake it. The strip's ✕ was hidden along with the two split buttons beside
// it, on the argument that a phone cannot use a pane arrangement — which is an
// argument for not OFFERING one, and it took the exit away with the entrance.
// Nothing withdrew the two ways in, so the only way out was knowing to type
// ">close pane" into an overlay meant for finding notes.
//
// The drawer stays shut for all of these: it is 280 of 390 points with a scrim
// over the rest, so an open tree covers both strips and every tap would land on
// the scrim instead of the control it names.
test.describe("a split this client can make, it can leave", () => {
  const editors = (page: Page) => page.locator(".cm-editor");
  const closePane = (page: Page) => page.getByRole("button", { name: /Close Pane/ });

  test("with one pane there is no exit, because there is nothing to leave", async ({
    page,
  }) => {
    // What keeps the control free: canClosePane withholds it until a second
    // pane exists, so the state a phone actually lives in pays nothing for it.
    // Its two neighbours are gone at every width — they are the arrangement,
    // not the way back from it.
    await expect(editors(page)).toHaveCount(1);
    await expect(closePane(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Split Right/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Split Down/ })).toHaveCount(0);
  });

  test("a split made from the palette is closed from the strip", async ({ page }) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(">split right");
    await page.keyboard.press("Enter");
    await expect(editors(page)).toHaveCount(2);
    // One per pane, in the strip of the pane it closes, so nothing has to be
    // focused or pointed at first — the same property that let the palette
    // carry the other two.
    await expect(closePane(page)).toHaveCount(2);
    await closePane(page).first().tap();
    await expect(editors(page)).toHaveCount(1);
    await expect(closePane(page)).toHaveCount(0);
  });

  test("and it is a target a finger can hit", async ({ page }) => {
    // The sweep below walks the states a phone can reach, and a two-pane
    // arrangement is not one of them: it walks the chrome, not every layout the
    // registry can produce. So this control asserts its own 44.
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(">split right");
    await page.keyboard.press("Enter");
    const box = await closePane(page).first().boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("a split made from a tab's menu is closed from the same menu", async ({
    page,
  }) => {
    // The menu is where this client makes a split, having no ⌘D, and it offered
    // both splits and no way back. Both verbs are pane-scoped and both address
    // the pressed tab's pane, not the focused one.
    await pressAndHold(page.locator("[data-tab]").first());
    await page.getByRole("menuitem", { name: "Split Down" }).tap();
    await expect(editors(page)).toHaveCount(2);
    await pressAndHold(page.locator("[data-tab]").first());
    await page.getByRole("menuitem", { name: "Close Pane" }).tap();
    await expect(editors(page)).toHaveCount(1);
  });
});

// --- so is the find panel (interactions.md §1a) ------------------------------
//
// The same defect one layer down, and not one the sweep could have found: the
// find toolbar is built by hand in editor/find.ts and themed in a JS style
// object in editor/setup.ts, so no `touch:` rule has ever reached it. It stayed
// a 26-point row at every width. At 390 the row measured 508, which put the ×
// that closes it 118 points past the right edge of a container that does not
// scroll, and the panel's other exit is Escape.
//
// These measure rather than read the stylesheet back. The bug was arithmetic —
// a row of fixed widths adding up to more than the screen — so the assertion
// has to be arithmetic too, and it fails again the day a fourth button joins
// the row.
//
// At two widths, because the first fix was tuned to one. It let flex wrap where
// the sum said, which was two tidy rows at 390 and, at a 430-point Pro Max, an
// × stranded between the field and the arrows with the checkboxes orphaned on
// the row below. A layout that only holds at the width someone tested is the
// same class of bug as the one above, and 390 alone cannot see it.
for (const width of [390, 430]) {
  test.describe(`the find panel a finger opens, a finger can close (${width}pt)`, () => {
    const panel = (page: Page) => page.locator(".ledge-search");
    const close = (page: Page) => page.locator(".ledge-search-close");
    const field = (page: Page) => page.locator(".ledge-search-field").first();

    // Find and Replace rather than Find: both rows on screen is the widest and
    // tallest the panel gets, and typing the whole title leaves the palette
    // with one row to act on (four commands start with "Find").
    async function openFind(page: Page): Promise<void> {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: /Go to Note/ }).tap();
      await page.keyboard.type(">find and replace");
      await page.keyboard.press("Enter");
      await expect(panel(page)).toBeVisible();
    }

    test("the × is beside the field, at the end of its row, and it closes the panel", async ({
      page,
    }) => {
      await openFind(page);
      const box = (await close(page).boundingBox())!;
      const query = (await field(page).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      // On the field's row and after it. Both halves matter: the stranded ×
      // was on the field's row too, with three buttons between it and the end.
      expect(box.y).toBeCloseTo(query.y, 0);
      expect(box.x).toBeGreaterThanOrEqual(query.x + query.width);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.x + box.width).toBeGreaterThanOrEqual(width - 16);
      // And the field has the rest of the row: the width minus two 44-point
      // controls, their gaps and the panel's padding. This is what the second
      // row is FOR, and it is the assertion the 430 case failed at 160 points.
      expect(query.width).toBeGreaterThanOrEqual(width - 120);
      // The tap, not Escape: Escape is the exit this client cannot press, and
      // a spec that closed the panel with it would pass on the broken layout.
      await close(page).tap();
      await expect(panel(page)).toHaveCount(0);
    });

    test("the options are all on the row under it", async ({ page }) => {
      await openFind(page);
      // Counted first, because "none of them are above the line" is a claim
      // about six controls and passes vacuously about none — which is exactly
      // what it did against the version that had no such box.
      await expect(
        page.locator(".ledge-search-opts .ledge-search-btn, .ledge-search-opts .ledge-search-check"),
      ).toHaveCount(6);
      const query = (await field(page).boundingBox())!;
      const above = await page.evaluate(
        (bottom) =>
          [...document.querySelectorAll(".ledge-search-opts *")]
            .filter((el) => el.getBoundingClientRect().top < bottom - 1)
            .map((el) => el.getAttribute("title") || el.textContent || el.tagName),
        query.y + query.height,
      );
      expect(above).toEqual([]);
    });

    test("and nothing in it runs off the edge of the screen", async ({ page }) => {
      await openFind(page);
      const over = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll(".ledge-search, .ledge-search *")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right <= window.innerWidth && r.left >= 0) continue;
          out.push(`${el.className || el.tagName} @ ${Math.round(r.left)}..${Math.round(r.right)}`);
        }
        return out;
      });
      expect(over).toEqual([]);
    });

    test("every control in it has a box at rest", async ({ page }) => {
      // The other half of gating the hovers. Four of these controls said where
      // they were only when a pointer was over them — the chevron, the × and
      // the three checkboxes are borderless on a Mac — and a client that cannot
      // hover has the resting state and nothing else. Computed style rather
      // than a screenshot, because what is being asserted is that a box exists
      // at all, and a border width is the honest measurement of that.
      await openFind(page);
      const bare = await page.evaluate(() =>
        [...document.querySelectorAll(".ledge-search-btn, .ledge-search-check")]
          .filter((el) => getComputedStyle(el).borderTopWidth === "0px")
          .map((el) => el.getAttribute("title") || el.textContent || el.tagName),
      );
      expect(bare).toEqual([]);
    });

    test("the button that rewrites the note says which All it is", async ({ page }) => {
      // Two buttons said "All": one selects every match, one replaces every
      // match. The title told them apart and a tooltip is a pointer's (§1a), so
      // the destructive one carries the word in its label.
      await openFind(page);
      await expect(page.getByRole("button", { name: "Replace All" })).toBeVisible();
      await expect(page.getByRole("button", { name: "All", exact: true })).toHaveCount(1);
    });
  });
}

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
    // What the line is, before what the prefix on it narrows. And no claim that
    // the key cannot open a shell: the protocol behind the forced command runs
    // code by design (remote.md §4a).
    await expect(dialog).toContainText("this device's public key");
    await expect(dialog).toContainText("keeps the key from forwarding ports or copying files");
    await expect(dialog).not.toContainText("opening a shell");
    await expect(dialog).not.toContainText("the only thing that key can do");
    await expect(dialog.getByText(/^restrict,command=/)).toBeVisible();
    await expect(dialog.getByLabel(/^Key/)).toHaveCount(0);

    // The pasteboard ends at the phone and the server is elsewhere, so the line
    // leaves by the device's share sheet as well (ios.md §4). The sheet itself
    // is UIKit's; what the view owns is offering it and handing over the line.
    await dialog.getByRole("button", { name: "Share Line" }).tap();
    expect(await page.evaluate(() => (window as unknown as { harnessShared?: string[] }).harnessShared ?? [])).toEqual([
      'restrict,command="ledge-server serve" ecdsa-sha2-nistp256 AAAAharness ledge-iphone-abc123',
    ]);

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

  test("no accelerator this keyboard cannot press: the chips drop their sigils", async ({
    page,
  }) => {
    // Absent rather than muted, which is §1a's rule for a control a client
    // cannot use — and what is absent here is the ADVICE, not the crossing: the
    // chip beside it still does what the character would have. `>` and `#` are
    // both on the third plane of an iPhone keyboard (123, then #+=), so printing
    // them would be telling this client about someone else's keys.
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await expect(chip(page, "Commands")).not.toContainText(">");
    await expect(chip(page, "Text")).not.toContainText("#");
    // And the field is back to saying what it is for. It used to spend itself
    // teaching the same two characters.
    await expect(page.getByPlaceholder("Search notes")).toBeVisible();
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
// interactions.md §6a: on a Mac a run takes the keyboard when it first speaks,
// so a `sudo` password goes to sudo instead of into the note, and the way back
// is ⌘Escape or two Escapes. A phone has no ⌘ and its software keyboard has no
// Escape at all, which leaves one exit inherited by accident — tapping the
// prose — and a full-screen program is exactly what takes that away: it pins
// the panel to 24 rows, and 24 rows with the keyboard up is the whole screen.
//
// So the panel carries the exit as a control on this client, and the run does
// not take the keyboard here at all: taking it means RAISING one over half the
// screen, and the claim's test cannot tell a phone that is being typed into
// from one that merely left focus in an editor. The desktop half (who claims
// the keyboard, and when the claim lapses) is inline-focus.spec.ts's and is not
// restated here.
const IN_TERMINAL = () => !!document.activeElement?.closest(".xterm");
const IN_EDITOR = () => !!document.activeElement?.classList.contains("cm-content");

// A block run by finger, then made to speak, and the id of the run. PTYs are
// inert in the harness, so `runOutput` pushes the first byte the way Bun's
// runEvent would — which on a Mac is the moment the run claims the keyboard,
// and here is the moment the panel starts inviting a tap.
async function speakingRun(page: Page): Promise<string> {
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Untitled\n\n```sh\nsudo ls\n```\n");
  await page.locator('[data-act="run"]').tap();
  await expect(page.locator(".ledge-output")).toBeVisible();
  const runs = await page.evaluate(() => window.__harness.inlineRuns());
  const id = runs[runs.length - 1]!.id;
  await page.evaluate((runId) => window.__harness.runOutput(runId, "Password:"), id);
  return id;
}

// The same, with the tap that answers it: everything below about giving the
// keyboard BACK needs the panel to have it first, and on this client that is
// something the user does rather than something the run does.
async function talkingRun(page: Page): Promise<string> {
  const id = await speakingRun(page);
  await page.locator(".xterm-screen").tap();
  await expect.poll(() => page.evaluate(IN_TERMINAL)).toBe(true);
  return id;
}

test.describe("giving the keyboard back, with no key to press", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(
      page.getByRole("button", { name: /Toggle Sidebar/ }),
    ).toBeVisible();
  });

  test("a run does not raise the keyboard: it waits to be tapped", async ({ page }) => {
    // The whole reason the claim is off here. `view.hasFocus` is what a claim
    // is tested against, and on this client it is true from the moment a pane
    // opens and again after every run hands focus back — so honoring it moved
    // the keyboard into a text field nobody asked to type in, which on iOS is
    // how the software keyboard is raised. The output a finger just asked to
    // see went behind it.
    await speakingRun(page);
    expect(await page.evaluate(IN_TERMINAL)).toBe(false);
    expect(await page.evaluate(IN_EDITOR)).toBe(true);
    // And the panel says how to get in, because nothing else would: a program
    // waiting on a password is waiting on a tap.
    await expect(page.locator(".ledge-tap-hint")).toBeVisible();
  });

  test("the invitation is itself a target, and the output stays one", async ({ page }) => {
    await speakingRun(page);
    // Words that say "tap to type" beside a terminal get aimed at, not just
    // read, so they are a button and it does what it says.
    await page.locator(".ledge-tap-hint").tap();
    await expect.poll(() => page.evaluate(IN_TERMINAL)).toBe(true);

    // And the older way in is untouched: the button is an extra target, not a
    // replacement for tapping the output.
    await page.locator(".ledge-term-leave").tap();
    await expect.poll(() => page.evaluate(IN_EDITOR)).toBe(true);
    await page.locator(".xterm-screen").tap();
    await expect.poll(() => page.evaluate(IN_TERMINAL)).toBe(true);
  });

  // The invitation is the only thing on this client that asks for a keystroke,
  // so it is the only thing that can ask for one nothing can carry. A tap here
  // would put the keyboard in a panel whose program is out of reach
  // (inlineTerm.ts accepts), which is the silent drop the header just stopped
  // telling: the two have to agree.
  test("the invitation goes while the machine is out of reach", async ({ page }) => {
    await speakingRun(page);
    await expect(page.locator(".ledge-tap-hint")).toBeVisible();

    await page.evaluate(() =>
      window.__harness.linkState("lost", "Lost the connection: the network is unreachable."),
    );

    await expect(page.locator(".ledge-status")).toHaveText("Disconnected");
    await expect(page.locator(".ledge-tap-hint")).toBeHidden();
  });

  test("the invitation goes once it has been taken, and once the run is over", async ({
    page,
  }) => {
    const id = await talkingRun(page);
    // Answered: the panel has the keyboard, and the line that says so is the
    // other one.
    await expect(page.locator(".ledge-tap-hint")).toBeHidden();
    await expect(page.locator(".ledge-term-leave")).toBeVisible();

    await page.locator(".ledge-term-leave").tap();
    await expect.poll(() => page.evaluate(IN_EDITOR)).toBe(true);
    await expect(page.locator(".ledge-tap-hint")).toBeVisible();

    // A frozen panel is output, not a program: typing into it would be typing
    // at nothing, so it stops asking.
    await page.evaluate((runId) => window.__harness.runEnd(runId, 0), id);
    await expect(page.locator(".ledge-status")).toHaveText("Done");
    await expect(page.locator(".ledge-tap-hint")).toBeHidden();
  });

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

// --- the keys a running block needs -----------------------------------------
//
// The other half of the same problem (ios.md §7, §14). A phone can ANSWER a run
// by typing — a password, a `[y/N]`, a pager's q — and had no key at all for
// the program that wants Ctrl-C, Ctrl-D, Escape or an arrow: a software
// keyboard has none of them, and the accessory bar carried the note's Markdown
// verbs over every field in the page, this panel included.
//
// So the bar has a second face over a running block. The face itself is Swift
// and only the Simulator can show it; what is asserted here is the half with
// rules in it — which panel a key lands in, what bytes it becomes, and that the
// page can tell a run apart from the note it is running inside.
test.describe("the run's own keyboard", () => {
  const inputs = (page: Page, id: string) =>
    page.evaluate(
      (runId) =>
        window.__harness
          .inlineInputs()
          .filter((i) => i.id === runId)
          .map((i) => i.data),
      id,
    );
  const press = (page: Page, key: string) =>
    page.evaluate((k) => window.__harness.runKey(k), key);

  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(page.getByRole("button", { name: /Toggle Sidebar/ })).toBeVisible();
  });

  test("the four things a software keyboard cannot say reach the program", async ({
    page,
  }) => {
    const id = await talkingRun(page);
    for (const key of ["ctrlC", "ctrlD", "escape", "up", "down", "left", "right"]) {
      expect(await press(page, key)).toBe(true);
    }
    expect(await inputs(page, id)).toEqual([
      "\x03",
      "\x04",
      "\x1b",
      "\x1b[A",
      "\x1b[B",
      "\x1b[D",
      "\x1b[C",
    ]);
  });

  // Typing still works and is unchanged: the bar is what the keyboard cannot
  // type, not a replacement for it.
  test("beside what is typed, in the order it happened", async ({ page }) => {
    const id = await talkingRun(page);
    await page.keyboard.type("hunter2");
    await press(page, "ctrlC");
    expect((await inputs(page, id)).join("")).toBe("hunter2\x03");
  });

  test("a key lands in the panel that has the keyboard, and nowhere when none does", async ({
    page,
  }) => {
    const id = await talkingRun(page);
    await page.locator(".ledge-term-leave").tap();
    await expect.poll(() => page.evaluate(IN_EDITOR)).toBe(true);
    // The bar is gone with the focus on a real phone; here the call is made
    // anyway, because "no panel has it" is the state a stale tap arrives in.
    expect(await press(page, "ctrlC")).toBe(false);
    expect(await inputs(page, id)).toEqual([]);
  });

  test("Back to note is a key on that bar, because the panel's own can scroll away", async ({
    page,
  }) => {
    const id = await talkingRun(page);
    expect(await press(page, "leave")).toBe(true);
    await expect.poll(() => page.evaluate(IN_EDITOR)).toBe(true);
    // Leaving is a focus move: nothing was sent to the program, and it is still
    // running. The ✕ is the one that interrupts.
    expect(await inputs(page, id)).toEqual([]);
    await expect(page.locator(".ledge-status")).toHaveText("Running");
  });

  // The bar is native and its taps arrive as bare strings, so a name this page
  // does not know has to be a refusal rather than bytes nobody chose.
  test("a name the page does not know sends nothing", async ({ page }) => {
    const id = await talkingRun(page);
    expect(await press(page, "ctrlZ")).toBe(false);
    expect(await press(page, "format.bold")).toBe(false);
    expect(await inputs(page, id)).toEqual([]);
  });

  test("the bar's face follows the focus into the panel and back out", async ({
    page,
  }) => {
    await talkingRun(page);
    // The reason the order inside barFaceOf matters, asserted rather than
    // asserted about: the panel a run draws IS inside the editor's content, so
    // "is this the note?" is true of it too, and the bar would offer Bold to a
    // program waiting for a password.
    expect(
      await page.locator(".ledge-output").evaluate((el) => !!el.closest(".cm-content")),
    ).toBe(true);
    expect(await page.evaluate(() => window.__harness.barFace())).toBe("run");

    await page.locator(".ledge-term-leave").tap();
    await expect.poll(() => page.evaluate(IN_EDITOR)).toBe(true);
    expect(await page.evaluate(() => window.__harness.barFace())).toBe("note");

    // And neither face over the search box: the note's verbs would act on the
    // note behind it. What the shell puts there instead is one button that is
    // never wrong to offer — the one that puts the keyboard away, since nothing
    // else on this screen can (ios/Sources/AccessoryBar.swift).
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await expect(page.getByPlaceholder(/Search notes/)).toBeVisible();
    expect(await page.evaluate(() => window.__harness.barFace())).toBe("none");
  });
});

// --- the block a finger can make ---------------------------------------------
//
// ``` is three trips through the iPhone keyboard's numeric page with a long
// press each, for the one construct this app is for. Code Block is that act as
// a verb: on the accessory bar (Swift, so the Simulator shows it) and in the
// palette, which is what a spec can drive.
test.describe("making a code block without typing a backtick", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(page.getByRole("button", { name: /Toggle Sidebar/ })).toBeVisible();
  });

  async function emptyNote(page: Page): Promise<void> {
    await page.keyboard.press("Meta+n");
    await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText("# Untitled\n\n");
  }

  const codeBlock = async (page: Page): Promise<void> => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(">code block");
    await page.keyboard.press("Enter");
  };

  test("the palette makes the block, and it is one the ▶ will run", async ({ page }) => {
    await emptyNote(page);
    await codeBlock(page);
    // A language, not a bare fence: the ▶ comes from the info string's first
    // word, so a block without one is the block a phone cannot use.
    await expect(page.locator(".cm-line", { hasText: "```sh" })).toHaveCount(1);
    await expect(page.locator('[data-act="run"]')).toHaveCount(1);
  });

  test("the caret is in the body, so the next thing typed is the command", async ({
    page,
  }) => {
    await emptyNote(page);
    await codeBlock(page);
    await page.keyboard.type("git status");
    // Inside the fences, which is the whole claim: one verb and the command.
    const lines = await page.locator(".cm-line").allInnerTexts();
    const at = lines.findIndex((l) => l.includes("git status"));
    expect(lines[at - 1]).toContain("```sh");
    expect(lines[at + 1]).toContain("```");
  });

  test("a selection is wrapped, with the language ready to be replaced", async ({
    page,
  }) => {
    await emptyNote(page);
    await page.keyboard.insertText("SELECT 1");
    await page.keyboard.press("Shift+Home");
    await codeBlock(page);
    // The code was already written and the language is the guess: typing over
    // the selection is the one gesture that fixes it.
    await page.keyboard.type("sql");
    await expect(page.locator(".cm-line", { hasText: "```sql" })).toHaveCount(1);
    await expect(page.locator(".cm-line", { hasText: "SELECT 1" })).toHaveCount(1);
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

// --- every target, measured (interactions.md §1a) ----------------------------
//
// The rule is "a control a finger chooses BETWEEN is at least 44 points", and
// the specs above assert it one named control at a time — the fence's ▶, the
// run panel's Back to note. Naming them is how the app ended up with a 38-point
// header of 25-point buttons, a 13-point Trash disclosure and a 21-point
// machine switcher: nobody wrote a spec for the control they did not think of.
//
// So this one names nothing. It walks the states a phone can reach, asks the
// DOM for every interactive element in each, and fails on any that is under 44
// in either direction. A control added at 25 points fails here without anyone
// having to remember it exists, which is the whole difference between a spec
// that measures and a spec that remembers.
test.describe("every target a finger chooses between", () => {
  // Interactive by the browser's reckoning, plus the two kinds this app makes
  // out of divs: a tab and a row. `[tabindex="-1"]` is excluded because it is
  // how a roving list parks the rows it is NOT on — they are still tap targets,
  // and they match `[data-target-kind]` above, so nothing is lost.
  const SWEEP = `(() => {
    const sel = [
      'button', '[role=menuitem]', '[role=option]', '[role=button]', 'a[href]',
      'input', 'select', 'textarea', '[tabindex]:not([tabindex="-1"])',
      '[data-tab]', '[data-target-kind]', '.ledge-btn',
    ].join(',');
    const bad = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      // Zero-sized is not a small target, it is no target: a control the
      // layout has not given a box to cannot be tapped by accident either.
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      // A control its own label wraps is not a target of its own: a tap
      // anywhere in the label reaches it, so the label's box is the one a
      // finger aims at and the one that has to be 44. The find panel's three
      // checkboxes are twelve points inside a 44-point pill (editor/find.ts),
      // which is the shape this is about.
      const label = el.closest('label');
      if (label && label !== el) {
        const lr = label.getBoundingClientRect();
        if (lr.width >= 44 && lr.height >= 44) continue;
      }
      if (r.width >= 44 && r.height >= 44) continue;
      bad.push(
        (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.tagName)
          .trim().slice(0, 40) + ' @ ' + Math.round(r.width) + 'x' + Math.round(r.height),
      );
    }
    return bad;
  })()`;

  const sweep = (page: Page) => page.evaluate(SWEEP);

  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(
      page.getByRole("button", { name: /Toggle Sidebar/ }),
    ).toBeVisible();
  });

  test("the chrome, the tree and the strip", async ({ page }) => {
    // The header at rest: seven lit buttons that do seven unrelated things,
    // and the densest row of adjacent alternatives in the app.
    expect(await sweep(page)).toEqual([]);

    await openSidebar(page);
    // The drawer is a phone's ONLY way to another note, so its rows, the
    // machine switcher above them and the Trash disclosure below all count.
    expect(await sweep(page)).toEqual([]);

    await noteRow(page, "Alpha").tap();
    await expect(page.locator(".cm-editor")).toBeVisible();
    await openSidebar(page);
    await noteRow(page, "Beta").first().tap();
    await expect.poll(() => page.locator("[data-tab]").count()).toBeGreaterThan(1);
    // The tab strip, whose tabs touch each other with no gap at all.
    expect(await sweep(page)).toEqual([]);
  });

  test("the overlay, a row menu, and a row being renamed", async ({ page }) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await expect(page.getByPlaceholder(/Search notes/)).toBeVisible();
    await page.keyboard.type("a");
    await expect(
      page.locator("div.fixed.inset-0.z-50").getByText("Alpha", { exact: true }),
    ).toBeVisible();
    // The one surface that carries every command on a client with no chords.
    expect(await sweep(page)).toEqual([]);
    await page.keyboard.press("Escape");

    await openSidebar(page);
    await pressAndHold(noteRow(page, "Alpha"));
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await sweep(page)).toEqual([]);
    await page.keyboard.press("Escape");

    // Rename is where a row stops being a row and becomes a text field, and
    // the field is the only thing in the app that grows its own row to obey
    // the rule (components/RenameField.tsx).
    await pressAndHold(page.locator('[data-target-kind="workspace"]').first());
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Rename Workspace…" })
      .tap();
    await expect(
      page.locator('[data-target-kind="workspace"] input'),
    ).toBeFocused();
    expect(await sweep(page)).toEqual([]);
  });

  test("the three right-hand panels", async ({ page }) => {
    await openSidebar(page);
    await noteRow(page, "Alpha").tap();
    await expect(page.locator(".cm-editor")).toBeVisible();

    for (const name of [/Toggle Outline/, /Toggle Backlinks/, /Toggle Tags/]) {
      // From the banner: each panel's own ✕ runs the same command and so
      // carries the same tooltip, which is two matches for one name.
      const button = page.getByRole("banner").getByRole("button", { name });
      await button.tap();
      // Each panel covers the note here, so its ✕ is the only way back.
      expect(await sweep(page)).toEqual([]);
      await button.tap();
    }
  });

  test("the find panel, which no `touch:` rule reaches", async ({ page }) => {
    // The one surface in the app that Tailwind does not style: CodeMirror's
    // panel slot, filled by editor/find.ts and sized by a JS style object
    // (editor/setup.ts). The sweep does not care where a rule comes from, which
    // is the point of sweeping the rendered boxes instead of the sources.
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await page.keyboard.type(">find and replace");
    await page.keyboard.press("Enter");
    await expect(page.locator(".ledge-search")).toBeVisible();
    // Ten targets, four of them a glyph wide: two arrows, three checkboxes and
    // the ×, which is the only way out of this panel on a client with no
    // Escape.
    expect(await sweep(page)).toEqual([]);
  });

  test("the machine switcher, and the dialog it opens", async ({ page }) => {
    await openSidebar(page);
    await page.locator("[data-connection]").tap();
    await expect(page.getByRole("dialog", { name: "Connections" })).toBeVisible();
    // Three adjacent alternatives per row — switch, edit, remove — and the
    // third is destructive (§4-1).
    expect(await sweep(page)).toEqual([]);
  });
});

// --- the stacking ladder (index.css) -----------------------------------------
//
// A block's controls are drawn in a layer parented to <body> rather than to the
// pane whose editor they cover, so their z-index competes with the whole app's
// instead of with the note's. They sat at 100, above every dialog, drawer and
// menu the app can put on screen. On a pointer client that was a ▶ painted over
// an open dialog and nothing worse. Here the same buttons are 44 points square
// and take pointer events, so a tap aimed at the dialog ran the block behind it.
//
// What these assert is what a tap lands on, not what the stylesheet says. A
// spec that read the two z-indexes back and compared them would still pass the
// day a third layer arrives between them, and these two are declared in a
// different file from the rest of the ladder, so declaration order is not
// evidence either.
test.describe("what covers the note covers its block controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/harness.html?shell=ios");
    await expect(page.getByRole("button", { name: /Toggle Sidebar/ })).toBeVisible();
    await page.keyboard.press("Meta+n");
    await expect(page.locator(".cm-line").first()).toHaveText("# Untitled");
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText(
      "# Untitled\n\n[a link](https://example.com)\n\n```sh\nsudo ls\n```\n",
    );
    await expect(page.locator('[data-act="run"]')).toHaveCount(1);
    await expect(page.locator(".ledge-hotspot")).toHaveCount(1);
  });

  // Everything in the two body-parented layers that still takes its own taps:
  // the block's buttons, and the invisible hotspot a rendered link is clicked
  // through. Both layers pass pointer events except at those, and both were
  // above the modal layer. elementFromPoint at the middle asks what WebKit asks
  // when a finger lands there, which is the question the bug was about, and it
  // honours `pointer-events`, so the layers themselves stay transparent to it.
  const takingTaps = (page: Page) =>
    page.evaluate(`(() => {
      const taken = [];
      const sel = '.ledge-overlay .ledge-btn, .ledge-linklayer .ledge-hotspot';
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        if (hit && el.contains(hit)) taken.push(el.title || el.dataset.act || el.className);
      }
      return taken;
    })()`);

  test("with nothing over the note, they take their own taps", async ({ page }) => {
    // The control for the three below. A probe that found nothing — wrong
    // selector, controls not drawn yet, a layer that had gone — would pass
    // every "covered" assertion without the ladder existing at all.
    // ▶ and Copy (no terminal drawer on this client), and the link's hotspot.
    expect(await takingTaps(page)).toHaveLength(3);
  });

  test("a dialog takes the tap, not the ▶ underneath it", async ({ page }) => {
    await openSidebar(page);
    await page.locator("[data-connection]").tap();
    await expect(page.getByRole("dialog", { name: "Connections" })).toBeVisible();
    expect(await takingTaps(page)).toEqual([]);
  });

  test("so does the palette", async ({ page }) => {
    await page.getByRole("button", { name: /Go to Note/ }).tap();
    await expect(page.getByPlaceholder(/Search notes/)).toBeVisible();
    expect(await takingTaps(page)).toEqual([]);
  });

  test("and the drawer, whose scrim is what covers the note", async ({ page }) => {
    // The drawer is 280 of 390 points and the controls are at the note's right
    // edge, so the thing actually over them is the scrim. It is on the ladder
    // for that reason: a tap on the dark part of the screen closes the tree,
    // and it used to run whatever block was under the dark part instead.
    await openSidebar(page);
    await expect(scrim(page)).toBeVisible();
    expect(await takingTaps(page)).toEqual([]);
  });
});
