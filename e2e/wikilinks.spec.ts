// Wikilinks (editor/wikilinks.ts + livePreview.ts): `[[` completes note
// titles, `[[title#heading]]` reveals that heading, a resolved link hides its
// brackets and opens its note on plain click, a dangling one is drawn muted
// and resolves live once its note exists, and a background tab's hotspots
// leave the screen with it (interactions.md §6). Runs in real WebKit: unit
// tests cannot see completion popups, hotspots, or focus (testing.md §5).
import { expect, test, type Locator, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

// A visible completion popup does not always accept Enter. acceptCompletion
// returns false in two windows, and Enter inserts a newline instead. While a
// keystroke's re-query is in flight, the popup carries the
// cm-tooltip-autocomplete-disabled class, which an assertion can wait on.
// Enter is also refused for 75ms after the popup opens (interactionDelay), so
// a popup appearing under someone's fingers cannot swallow a newline. That
// window has no DOM signal, so it has to be slept out. Neither window catches
// a person typing. They catch the driver, whose keystrokes a loaded parallel
// run can space further apart than the popup's 100ms activation debounce. So
// before pressing Enter: wait out the disabled class, then wait another 100ms.
// The open timestamp survives a re-query, so it is at least as old as the
// visibility observed here, and 100ms past that clears the 75ms delay
// deterministically.
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

  // Escape closes the popup and nothing else. The editor keeps focus and the
  // text is untouched (interactions.md §6: editor-internal, like find).
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(page.locator(".cm-line").first()).toHaveText("see [[");

  // Typing narrows the list. Enter accepts the completion and closes the
  // brackets. The caret lands after ]], still touching the link, so the link
  // shows raw.
  await page.keyboard.type("Al");
  await expect(popup.locator("li")).toHaveCount(1);
  await completionAcceptReady(page, popup);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line").first()).toHaveText("see [[Alpha]]");

  // With the caret off the line, the brackets are hidden and the link is
  // drawn live.
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line").first()).toHaveText("see Alpha");
  await expect(page.locator(".ledge-mdlink-live")).toHaveCount(1);
});

test("a rendered wikilink opens its note on plain click", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("go [[Alpha]]");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line").first()).toHaveText("go Alpha");

  // The rendered link gets the same WKWebView-proof hotspot as a URL link.
  // Its title promises a note, not a browser.
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

  // A dangling link is drawn muted and gets no hotspot. A click there moves
  // the caret instead of acting like a button.
  await expect(page.locator(".ledge-wikilink-dangling")).toHaveCount(1);
  await expect(page.locator(".ledge-hotspot")).toHaveCount(0);

  // Create the note it names (autosave allocates the file and the browser
  // row appears), then come back. The same text now draws as a resolved link.
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
  // A target note whose heading sits below its first line.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("# Target\n\nintro\n\n## Section Two\n\ntail");
  await expect(noteRow(page, "Target")).toBeVisible();

  // A second note linking to that heading.
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("jump [[Target#Section Two]]");
  await page.keyboard.press("Enter");

  await page.locator(".ledge-hotspot").click();
  // The link lands in Target's editor with the caret on the heading line.
  // ATX marks show raw only while the selection touches the heading, so a line
  // reading "## Section Two" rather than "Section Two" is the proof.
  await expect(page.locator(".cm-line", { hasText: "## Section Two" })).toBeVisible();
  const focusInEditor = await page.evaluate(
    () => !!document.activeElement?.closest(".cm-editor"),
  );
  expect(focusInEditor).toBe(true);
});

// The hotspot layer is parented to <body>, not to the pane (livePreview.ts
// says why), so it does not leave the screen when its editor's host does. If a
// background tab keeps its hotspots, they sit in viewport coordinates over
// whichever editor is now in front: invisible pointer-events targets still
// carrying the other note's links (interactions.md §6).
test("a background tab's hotspots leave the screen with it", async ({ page }) => {
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("go [[Alpha]]");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ledge-hotspot")).toHaveCount(1);
  const spot = await page.locator(".ledge-hotspot").boundingBox();

  // A second tab, with nothing clickable anywhere in it.
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("nothing here is a link");
  await expect(page.locator(".cm-line").first()).toHaveText("nothing here is a link");

  await expect(page.locator(".ledge-hotspot")).toHaveCount(0);

  // The consequence: a click where the other tab's link used to be moves the
  // caret in this note instead of opening Alpha.
  await page.mouse.click(spot!.x + spot!.width / 2, spot!.y + spot!.height / 2);
  await expect(page.locator("[data-tab]", { hasText: "Alpha" })).toHaveCount(0);
  await expect(page.locator(".cm-line").first()).toHaveText("nothing here is a link");

  // Collapsed, not destroyed: coming back to the first tab brings its hotspot
  // back. A fix that removes hotspots on detach without restoring them on
  // re-attach is the same bug with the sign flipped (interactions.md §6).
  await page.locator("[data-tab]", { hasText: "Untitled" }).first().click();
  await expect(page.locator(".cm-line").first()).toHaveText("go Alpha");
  await expect(page.locator(".ledge-hotspot")).toHaveCount(1);
});
