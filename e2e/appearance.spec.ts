// Light/dark appearance: the OS by default, pinned by `appearance.theme`.
// The palette is keyed off `data-theme` on <html> (index.css), resolved by
// lib/theme.ts from the setting plus prefers-color-scheme, so these specs
// drive the two inputs (Playwright's emulated color scheme, the harness's
// ?theme= boot override) and assert the one output plus a pixel that proves
// the variables actually followed it.
import { expect, test, type Page } from "@playwright/test";

const theme = (page: Page) => page.locator("html");
// The body background comes from --background, the token both palettes set:
// asserting it is how "the attribute flipped" is distinguished from "the
// attribute flipped and the whole stylesheet came with it".
const bodyBg = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe("following the system", () => {
  test.use({ colorScheme: "dark" });

  test("a dark Mac gets the dark palette with no setting at all", async ({ page }) => {
    await page.goto("/harness.html");
    await expect(theme(page)).toHaveAttribute("data-theme", "dark");
    expect(await bodyBg(page)).toBe("rgb(9, 9, 11)");
  });
});

test.describe("following the system, the other way", () => {
  test.use({ colorScheme: "light" });

  test("a light Mac gets the light palette", async ({ page }) => {
    await page.goto("/harness.html");
    await expect(theme(page)).toHaveAttribute("data-theme", "light");
    expect(await bodyBg(page)).toBe("rgb(255, 255, 255)");
  });
});

test.describe("pinned against the system", () => {
  test.use({ colorScheme: "light" });

  test('theme "dark" wins over a light Mac', async ({ page }) => {
    await page.goto("/harness.html?theme=dark");
    await expect(theme(page)).toHaveAttribute("data-theme", "dark");
    expect(await bodyBg(page)).toBe("rgb(9, 9, 11)");
  });
});

test.describe("pinned against the system, the other way", () => {
  test.use({ colorScheme: "dark" });

  test('theme "light" wins over a dark Mac, editor variables included', async ({ page }) => {
    await page.goto("/harness.html?theme=light");
    await expect(theme(page)).toHaveAttribute("data-theme", "light");
    expect(await bodyBg(page)).toBe("rgb(255, 255, 255)");
    // The editor's own palette (--fg and friends) is a separate block from the
    // shadcn tokens above; it has to be keyed off the same attribute or the
    // note text would stay dark-mode white on a forced-light window.
    const fg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--fg").trim(),
    );
    expect(fg).toBe("#1d1d1f");
  });
});
