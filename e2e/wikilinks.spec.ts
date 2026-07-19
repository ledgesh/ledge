// Wikilinks (editor/wikilinks.ts + livePreview.ts): `[[` completes note
// titles, a resolved link conceals and opens its note on plain click, a
// dangling one styles muted and resolves live when its note comes to exist,
// and `[[title#heading]]` reveals the heading it names. Run in real WebKit
// because completion popups, hotspots, and focus are exactly what unit tests
// cannot see (testing.md §5).
import { expect, test, type Locator, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// A visible completion popup is not yet an accepting one. acceptCompletion
// ignores Enter (falling through to insert-newline) in two windows: while a
// keystroke's re-query is in flight — the popup renders its stale options
// grayed, with the -disabled class — and for interactionDelay (75ms) after
// opening, the guard against a popup swallowing a newline as it appears under
// the user's fingers. No human outruns either window, but the driver does,
// exactly when a loaded parallel run staggers keystrokes past the popup's
// 100ms activation debounce. So before pressing Enter: wait out the disabled
// state (observable), then one 100ms beat — the open timestamp is preserved
// across re-queries, so it is at least as old as the visibility we observed,
// and 100ms past that clears the 75ms delay deterministically.
const completionAcceptReady = async (page: Page, popup: Locator) => {
  await expect(popup).not.toHaveClass(/cm-tooltip-autocomplete-disabled/);
  await page.waitForTimeout(100);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
});

test("[[ pops the note picker; accepting closes the brackets", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("see [[");

  // The picker offers the workspace's notes.
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup).toBeVisible();
  await expect(popup.locator("li", { hasText: "Alpha" })).toBeVisible();
  await expect(popup.locator("li", { hasText: "Beta" })).toBeVisible();

  // Escape closes the popup and nothing else — the editor keeps focus and
  // the text is untouched (interactions.md §6: editor-internal, like find).
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(page.locator(".cm-line").first()).toHaveText("see [[");

  // Typing filters; Enter accepts and closes the brackets. The caret lands
  // after ]] — still touching the link, so it shows raw.
  await page.keyboard.type("Al");
  await expect(popup.locator("li")).toHaveCount(1);
  await completionAcceptReady(page, popup);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line").first()).toHaveText("see [[Alpha]]");

  // Caret off the line: the brackets conceal and the link renders live.
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line").first()).toHaveText("see Alpha");
  await expect(page.locator(".ledge-mdlink-live")).toHaveCount(1);
});

test("a rendered wikilink opens its note on plain click", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("go [[Alpha]]");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line").first()).toHaveText("go Alpha");

  // The rendered link gets the same WKWebView-proof hotspot as a URL link,
  // promising a note, not a browser.
  const hotspot = page.locator(".ledge-hotspot");
  await expect(hotspot).toHaveCount(1);
  await expect(hotspot).toHaveAttribute("title", "Click to open note");

  // Plain click opens the note: Alpha's tab joins the strip and its text is
  // on screen. Nothing left the app (no linkOpen recorded).
  await hotspot.click();
  await expect(page.locator("[data-tab]", { hasText: "Alpha" })).toBeVisible();
  await expect(page.locator(".cm-line", { hasText: "alpha body" })).toBeVisible();
  expect(await page.evaluate(() => window.__harness.linkOpens())).toHaveLength(0);
});

test("a dangling link styles muted, and resolves the moment its note exists", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("see [[Zeta]]");
  await page.keyboard.press("Enter");

  // Dangling: muted styling, and no hotspot — a click is a caret move, not a
  // dead button pretending otherwise.
  await expect(page.locator(".ledge-wikilink-dangling")).toHaveCount(1);
  await expect(page.locator(".ledge-hotspot")).toHaveCount(0);

  // Create the note it names (autosave allocates the file and the browser
  // row appears), then come back: the same text now renders resolved.
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Zeta");
  await expect(noteRow(page, "Zeta")).toBeVisible();
  await page.locator("[data-tab]", { hasText: "Untitled" }).first().click();
  await expect(page.locator(".cm-line", { hasText: "see Zeta" })).toBeVisible();
  await expect(page.locator(".ledge-wikilink-dangling")).toHaveCount(0);
  await expect(page.locator(".ledge-mdlink-live")).toHaveCount(1);
});

test("[[title#heading]] opens the note with that heading revealed", async ({ page }) => {
  // A target note with a heading past the fold of its first line.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Target\n\nintro\n\n## Section Two\n\ntail");
  await expect(noteRow(page, "Target")).toBeVisible();

  // A second note linking to that heading.
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("jump [[Target#Section Two]]");
  await page.keyboard.press("Enter");

  await page.locator(".ledge-hotspot").click();
  // The link lands IN Target's editor with the caret on the heading line —
  // proven by the reveal: ATX marks only show raw while the caret touches
  // their line, so seeing "## Section Two" (not "Section Two") IS the caret.
  await expect(page.locator(".cm-line", { hasText: "## Section Two" })).toBeVisible();
  const focusInEditor = await page.evaluate(
    () => !!document.activeElement?.closest(".cm-editor"),
  );
  expect(focusInEditor).toBe(true);
});
