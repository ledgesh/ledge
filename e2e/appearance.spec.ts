// Light/dark appearance: the OS by default, pinned by `appearance.theme`.
// The palette is keyed off `data-theme` on <html> (index.css), resolved by
// lib/theme.ts from the setting plus prefers-color-scheme, so these specs
// drive the two inputs (Playwright's emulated color scheme, the harness's
// ?theme= boot override) and assert the one output plus a pixel that proves
// the variables actually followed it.
import { expect, test, type Page } from "@playwright/test";
// The real variant strings, so the contrast spec below measures the button the
// app renders rather than a list of class names retyped in a test.
import { buttonVariants } from "../src/mainview/components/ui/button";

const theme = (page: Page) => page.locator("html");
// The body background comes from --background, the token both palettes set:
// asserting it is how "the attribute flipped" is distinguished from "the
// attribute flipped and the whole stylesheet came with it".
const bodyBg = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/**
 * What a set of classes actually resolves to, as a WCAG contrast ratio between
 * its own text colour and whatever is behind it, measured by the engine rather
 * than read off the stylesheet.
 *
 * The element is injected rather than found, because the thing under test is
 * the token and not any one message: every error surface in the app is a
 * `text-destructive` line, and a spec that drove the connection dialog to make
 * one appear would be asserting this about that dialog. `getComputedStyle` is
 * what makes it a measurement — it resolves the variable, the hsl(), and the
 * palette the `data-theme` attribute selected — so a token pointed at a colour
 * that does not exist fails here rather than passing on the text of the rule.
 *
 * `paintsItsOwn` is the difference between prose and a button, and it has to be
 * declared rather than detected. An element with no background of its own
 * computes to transparent, which for prose is correct — the page is what it
 * sits on — and for a filled control means the utility naming that fill was
 * never generated. Both look identical from in here, so treating the second as
 * the first measures white against the page, gets a magnificent ratio, and
 * reports a button that has stopped painting itself as legible. It did exactly
 * that once, which is why this is a parameter and not a fallback.
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
        // Opaque `rgb(r, g, b)` only, and the refusal is the point. A palette
        // built on color-mix() or carrying an alpha computes to
        // `color(srgb 0.98 0.37 0.34 / 0.88)` instead — channels 0-1 rather
        // than 0-255, and a translucent colour that has to be composited over
        // what is behind it before it means anything. Reading those numbers as
        // 0-255 yields a ratio that is wrong by a factor of ten and looks
        // entirely plausible, so this refuses to guess rather than reporting
        // fiction about whether an error message can be read.
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

// The floor is WCAG AA for body text, and it is the right floor rather than a
// strict one: these messages ship at 11 and 12 pixels, which is under every
// definition of "large", and they are read exactly once — at the moment
// something failed — by someone who is not going to lean in.
const AA = 4.5;

test.describe("error text is legible in both palettes", () => {
  // The regression this holds: shadcn's stock dark `--destructive` is red-900,
  // a FILL meant to carry near-white text, and the app writes prose in it.
  // Dark error messages sat at 1.99:1 — under even the 3:1 large-text floor —
  // and a dial that failed reported itself in dark red on near black.
  test("a failure reads on the dark background", async ({ page }) => {
    await page.goto("/harness.html?theme=dark");
    expect(await contrast(page, "text-destructive")).toBeGreaterThanOrEqual(AA);
  });

  test("a failure reads on the light background", async ({ page }) => {
    await page.goto("/harness.html?theme=light");
    expect(await contrast(page, "text-destructive")).toBeGreaterThanOrEqual(AA);
  });

  // The other half of the split, and the reason the token divided in two: the
  // one control that FILLS with the colour needs its label to survive on it,
  // and the value that does that is not the value prose needs. Asserting both
  // is what stops the next edit from fixing one by breaking the other.
  //
  // The classes come from `buttonVariants` rather than from a list written
  // here, so this measures the button the app renders. Naming them by hand
  // tests the pairing of two tokens and calls it a button: a variant that
  // stopped using the fill would keep this green, which is the state this spec
  // was in until a deliberately broken variant failed to turn it red.
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
