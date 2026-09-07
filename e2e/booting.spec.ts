// The app shows the boot screen while it waits for a server
// (mainview/lib/booting.ts). On a phone that wait can last a fifteen-second
// dial timeout, and interactions.md §4-1 says why the screen covers it. The
// harness raises the screen with `?booting=<ms>`, the way both real shells do:
// up before the waits, down before the first render (harness.tsx). Two specs
// read the reveal delays off the stylesheet; two wait one out in real time.
import { expect, test, type Page } from "@playwright/test";

const screen = (page: Page) => page.locator(".ledge-booting");
// The panel's "Choose a Different Server" button (mainview/lib/booting.ts),
// which the second reveal brings up 4s in.
const wayOut = (page: Page) => page.locator(".ledge-booting-cancel");

test("a boot that is waiting says so, and says which machine", async ({ page }) => {
  await page.goto("/harness.html?booting=9000&bootingTo=dan%40vps.example");
  await expect(screen(page)).toBeVisible();
  await expect(screen(page)).toHaveText(/Connecting to dan@vps\.example…/);
});

test("a boot that cannot name the machine yet still says what it is doing", async ({ page }) => {
  await page.goto("/harness.html?booting=9000");
  await expect(screen(page)).toHaveText(/Connecting…/);
});

test("the screen is announced, not asserted over what the reader is doing", async ({ page }) => {
  await page.goto("/harness.html?booting=9000&bootingTo=vps");
  await expect(screen(page)).toHaveAttribute("role", "status");
  await expect(screen(page)).toHaveAttribute("aria-live", "polite");
});

test("nothing is painted for the first half second, so a local boot never flashes it", async ({ page }) => {
  await page.goto("/harness.html?booting=9000&bootingTo=vps");
  // The assertion reads the delay out of the stylesheet rather than waiting for
  // it. The panel sits at opacity 0 until its fade-in animation starts, and the
  // animation-delay holds that animation off (index.css `.ledge-booting`).
  await expect(screen(page)).toHaveCSS("animation-delay", "0.6s");
});

test("the way out arrives later than the screen does, and is out of reach until it does", async ({ page }) => {
  await page.goto("/harness.html?booting=9000&bootingTo=vps");
  await expect(wayOut(page)).toHaveCSS("animation-delay", "4s");
  await expect(page.locator(".ledge-booting-slow")).toHaveCSS("animation-delay", "4s");
  // The button is `visibility: hidden` rather than transparent until its delay
  // is up, so a Tab before the reveal cannot land on it (index.css
  // `.ledge-booting-cancel`). This assertion has to run inside the 4s window
  // the goto above opened, so it fails on a machine slow enough to spend four
  // seconds on the lines before it.
  await expect(wayOut(page)).toBeHidden();
  await expect(wayOut(page)).toBeVisible({ timeout: 8000 });
});

test("pressing the way out asks the shell for its server list", async ({ page }) => {
  await page.goto("/harness.html?booting=9000&bootingTo=vps");
  await expect(wayOut(page)).toBeVisible({ timeout: 8000 });
  await wayOut(page).click();
  await expect(page.locator("body[data-booting-cancelled='1']")).toHaveCount(1);
});

test("the screen is gone the moment there is an app to show instead", async ({ page }) => {
  await page.goto("/harness.html?booting=300&bootingTo=vps");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await expect(screen(page)).toHaveCount(0);
});

test("an ordinary boot never puts it up at all", async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await expect(screen(page)).toHaveCount(0);
});
