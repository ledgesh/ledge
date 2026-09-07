// Light/dark appearance: the OS by default, pinned by `appearance.theme`.
// lib/theme.ts resolves that plus prefers-color-scheme into `data-theme` on
// <html>, and index.css keys the palette off it. The first describe measures
// error-colour contrast in each palette. The rest drive both inputs (emulated
// color scheme, ?theme=) and assert the attribute plus the background colour.
import { expect, test, type Page } from "@playwright/test";
// `buttonVariants` produces the real variant class strings. The contrast spec
// below measures the button the app renders rather than a list of class names
// retyped in a test.
import { buttonVariants } from "../src/mainview/components/ui/button";

const theme = (page: Page) => page.locator("html");
// The body background comes from --background, the token both palettes set
// (index.css). Asserting it separates "the attribute flipped" from "the
// attribute flipped and the whole stylesheet came with it".
const bodyBg = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/**
 * Returns the WCAG contrast ratio between the text colour these classes
 * produce and the background behind it. The numbers come from
 * getComputedStyle, so they are what the browser painted, not what the
 * stylesheet says. The span is injected rather than found in the page because
 * the subject is the token: `text-destructive` is the colour of error prose
 * all over the app, and driving the connection dialog to produce one message
 * would measure that dialog.
 *
 * Pass `paintsItsOwn` for a filled control; `contrast` cannot tell one from
 * prose. An element with no background computes to transparent. That is right
 * for prose, because the page is what it sits on. For a filled control it means
 * the utility naming that fill was never generated. The flag makes transparent
 * throw rather than fall back to the body background. Without it a broken
 * button is measured as prose, near-white text against the page returns a high
 * ratio, and the button passes. This spec passed a broken button once.
 */
async function contrast(
  page: Page,
  className: string,
  opts: { paintsItsOwn?: boolean } = {},
): Promise<number> {
  return page.evaluate(
    ([cls, paintsItsOwn]) => {
      const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const luminance = (color: string): number => {
        // Opaque `rgb(r, g, b)` only; anything else throws. A color-mix()
        // or alpha palette computes to `color(srgb 0.98 0.37 0.34 / 0.88)`
        // instead: channels run 0-1, not 0-255, and a translucent colour
        // means nothing until composited over what is behind it. Those
        // channels parsed as 0-255 yield a wrong ratio that looks plausible.
        const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*1)?\)$/.exec(color.trim());
        if (!m) throw new Error(`cannot measure "${color}": this helper reads opaque rgb() only.`);
        const [r, g, b] = m.slice(1, 4).map((n) => Number(n) / 255);
        return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
      };
      const el = document.createElement("span");
      el.className = cls as string;
      el.textContent = "Could not reach v1";
      document.body.appendChild(el);
      try {
        const style = getComputedStyle(el);
        const own = style.backgroundColor;
        const unpainted = /transparent|rgba\([^)]*,\s*0\)/.test(own);
        if (paintsItsOwn && unpainted) {
          throw new Error(`"${cls}" paints no background of its own — the fill utility it names was never generated.`);
        }
        const fg = luminance(style.color);
        const bg = luminance(unpainted ? getComputedStyle(document.body).backgroundColor : own);
        const [hi, lo] = [fg, bg].sort((a, b) => b - a);
        return (hi! + 0.05) / (lo! + 0.05);
      } finally {
        el.remove();
      }
    },
    [className, opts.paintsItsOwn ?? false] as const,
  );
}

// WCAG AA for body text, not the 3:1 large-text floor. These messages ship at
// 11 and 12 pixels, under every definition of "large" (index.css, the
// `--destructive` comment).
const AA = 4.5;

test.describe("error text is legible in both palettes", () => {
  // The regression these tests hold: shadcn's stock dark `--destructive` is
  // red-900, a fill meant to carry near-white text. The app writes prose in it,
  // so dark error messages sat at 1.99:1, under even the 3:1 large-text floor.
  // A failed connection showed as dark red on near black.
  test("a failure reads on the dark background", async ({ page }) => {
    await page.goto("/harness.html?theme=dark");
    expect(await contrast(page, "text-destructive")).toBeGreaterThanOrEqual(AA);
  });

  test("a failure reads on the light background", async ({ page }) => {
    await page.goto("/harness.html?theme=light");
    expect(await contrast(page, "text-destructive")).toBeGreaterThanOrEqual(AA);
  });

  // There are two destructive tokens. Prose uses `--destructive`. The one
  // destructive button paints `--destructive-fill` under its label. Once the
  // background stops being white, the value that keeps that label legible is
  // not the value prose needs (index.css). Measuring both stops an edit to one
  // from breaking the other.
  //
  // The classes come from `buttonVariants`, so this measures the button the app
  // renders. A hand-written class list would stay green after a variant stopped
  // using the fill.
  for (const theme of ["dark", "light"] as const) {
    test(`a destructive button's label reads on its fill (${theme})`, async ({ page }) => {
      await page.goto(`/harness.html?theme=${theme}`);
      const classes = buttonVariants({ variant: "destructive" });
      expect(await contrast(page, classes, { paintsItsOwn: true })).toBeGreaterThanOrEqual(AA);
    });
  }
});

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
