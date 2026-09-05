// The screen a boot shows while it is still waiting on a server
// (mainview/lib/booting.ts).
//
// The failure it exists to prevent is a black rectangle: both shells start on
// an empty `#root`, and filling it costs a phone a dial that can run to fifteen
// seconds. What is under test here is that the wait says something, that what
// it says names the machine, and that the two reveals are timed so the ordinary
// boot — a server in this process, answering in milliseconds — paints none of
// it. The last of those is asserted on the delays rather than by racing them:
// a spec that tried to catch the panel before it faded in would be asserting
// its own scheduling.
//
// `?booting=<ms>` is the harness holding the screen up (harness.tsx); the real
// shells raise it in the same shape, before the waits and down before the
// render.
import { expect, test, type Page } from "@playwright/test";

const screen = (page: Page) => page.locator(".ledge-booting");
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
  // The delay, not a race against it: the panel is transparent until its
  // animation starts, and the animation is what the delay is in front of.
  await expect(screen(page)).toHaveCSS("animation-delay", "0.6s");
});

test("the way out arrives later than the screen does, and is out of reach until it does", async ({ page }) => {
  await page.goto("/harness.html?booting=9000&bootingTo=vps");
  await expect(wayOut(page)).toHaveCSS("animation-delay", "4s");
  await expect(page.locator(".ledge-booting-slow")).toHaveCSS("animation-delay", "4s");
  // Hidden rather than merely transparent, so a Tab before it appears cannot
  // land on it.
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
