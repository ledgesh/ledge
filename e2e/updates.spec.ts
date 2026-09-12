// This app's own update (lib/updates.ts, releasing.md §7). The harness plays the
// shell: it pushes each state change and finishes a check with whatever the spec
// set. What is checked here is what a person sees: which of the pair the palette
// offers, and which notice a change earns.
import { expect, test, type Page } from "@playwright/test";

const noteRow = (page: Page, title: string) =>
  page.locator('[data-target-kind="note"]', { hasText: title });

function state(phase: string, version = "", detail = "") {
  return { phase, version, detail } as const;
}

async function openPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");
  await page.getByPlaceholder("Run a command").fill(query);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(noteRow(page, "Alpha")).toBeVisible();
});

test("Check for Updates… with nothing newer says which version is the latest", async ({ page }) => {
  await openPalette(page, "Check for Updates");
  await expect(page.locator("[data-active]")).toContainText("Check for Updates…");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Ledge 0.1.0 is the latest version.")).toBeVisible();
  expect(await page.evaluate(() => window.__harness.updateChecks())).toBe(1);
});

test("a check that fails is an error somebody can read", async ({ page }) => {
  await page.evaluate(() => window.__harness.setUpdateCheckResult({ phase: "failed", version: "", detail: "HTTP 500" }));
  await openPalette(page, "Check for Updates");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Could not update Ledge: HTTP 500")).toBeVisible();
});

// A background download finishing is the one change nobody asked about that
// still gets a notice. The palette then swaps faces.
test("a finished download is announced, and the palette offers Restart to Install Update instead", async ({ page }) => {
  await page.evaluate((s) => window.__harness.setUpdate(s), state("ready", "0.1.1"));
  await expect(page.getByText("Ledge 0.1.1 is ready. Choose Restart to Install Update in the Ledge menu.")).toBeVisible();

  await openPalette(page, "Check for Updates");
  await expect(page.locator("[data-active]")).toHaveCount(0);
  await page.getByPlaceholder("Run a command").fill("Restart to Install Update");
  await expect(page.locator("[data-active]")).toContainText("Restart to Install Update");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.updateInstalls())).toBe(1);
});

// A background check runs every day. Its "nothing newer" and its failures
// (a laptop offline at launch) must not put a strip in front of anyone.
test("a background check that finds nothing, or fails, shows nothing", async ({ page }) => {
  // Every text node the page adds while the pushes land. An absence assertion
  // alone would pass before a notice had a frame to render in. The ready push
  // at the end is the control: it does render, which proves the observer and
  // the strip were both working while the first three landed.
  const added = await page.evaluate(async (states) => {
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.textContent) seen.push(n.textContent);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    for (const s of states) window.__harness.setUpdate(s);
    await new Promise((resolve) => setTimeout(resolve, 300));
    observer.disconnect();
    return seen.join("\n");
  }, [state("checking"), state("failed", "", "offline"), state("current", "0.1.0"), state("ready", "0.1.1")]);
  expect(added).toContain("Ledge 0.1.1 is ready");
  expect(added).not.toContain("offline");
  expect(added).not.toContain("latest version");
});

// A phone or a dev build never updates itself, so both verbs are absent rather
// than present and failing (interactions.md §8).
test("a build that does not update offers neither verb", async ({ page }) => {
  await page.evaluate((s) => window.__harness.setUpdate(s), state("off", "", "Development builds do not update."));
  for (const verb of ["Check for Updates", "Restart to Install Update"]) {
    await openPalette(page, verb);
    await expect(page.locator("[data-active]")).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
});
