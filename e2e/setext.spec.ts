// A bullet list opened under a paragraph (editor/setext.ts). `-` on the line
// below prose is a real Setext underline, so CommonMark reads the pair as an
// H2 — and the prose above jumps to heading size the moment you start a list
// under it. The suppression is view-time and caret-scoped, so this is real
// WebKit or nothing: computed styles are the whole assertion.
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+n"); // a fresh scratch note, editor focused
  await page.keyboard.press("Meta+a");
});

// How each line actually draws: the first styled span, or the line itself.
const drawn = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".cm-content .cm-line")].map((line) => {
      const el = (line.querySelector("span[class]") ?? line) as HTMLElement;
      const cs = getComputedStyle(el);
      return `${cs.fontSize}/${cs.fontWeight}`;
    }),
  );

test("prose stays prose while a list is being opened under it", async ({ page }) => {
  await page.keyboard.type("This is a regular line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");

  // Both lines of the would-be heading draw as body text.
  const [prose, marker] = await drawn(page);
  expect(prose).toBe("18px/400");
  expect(marker).toBe("18px/400");

  // And once the item has text there is no heading left to suppress.
  await page.keyboard.type("item");
  expect(await drawn(page)).toEqual(["18px/400", "18px/400"]);
});

test("bold in that paragraph keeps its weight", async ({ page }) => {
  await page.keyboard.type("plain **bold** words");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");
  const bold = await page.evaluate(() => {
    const el = document.querySelector(".cm-line .ledge-strong") as HTMLElement | null;
    return el && `${el.textContent}:${getComputedStyle(el).fontWeight}`;
  });
  expect(bold).toBe("bold:700");
});

test("a Setext heading someone meant still draws as one", async ({ page }) => {
  await page.keyboard.type("Real heading");
  await page.keyboard.press("Enter");
  await page.keyboard.type("---");
  const [title, rule] = await drawn(page);
  expect(title).toBe("23.4px/700");
  expect(rule).toBe("23.4px/700");
});

test("the caret leaving a lone dash lets the heading draw", async ({ page }) => {
  await page.keyboard.type("Ambiguous line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("-");
  expect((await drawn(page))[0]).toBe("18px/400");

  // Moving off it stops being a list mid-birth and starts being what the file
  // says — the same honesty as live preview revealing syntax under the caret.
  await page.keyboard.press("Meta+ArrowUp");
  expect((await drawn(page))[0]).toBe("23.4px/700");
});
