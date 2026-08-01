// Which machine you are typing into (remote.md §8).
//
// The failure this whole surface exists to prevent is running a command on the
// wrong box, so the properties under test are about legibility and about
// refusals: the name is always on screen, a connection that will not open
// costs nothing, and the local server can never be removed out from under the
// app. The switch itself reloads the page — everything workspace-scoped is
// scoped to a server, and the view's boot is the rebuild — so what a spec can
// assert is that the reload happens, not what survives it.
import { expect, test, type Page } from "@playwright/test";

const bar = (page: Page) => page.locator("[data-connection]");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Connections" });

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
});

test("the machine holding the notes is named in the chrome, without being asked", async ({ page }) => {
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toHaveText(/This Mac/);
  await expect(bar(page)).toHaveAttribute("data-connection", "local");
});

test("the bar opens the chooser, and so does the palette", async ({ page }) => {
  await bar(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("Notes On");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
});

test("the chooser lists every configured machine and marks the one in use", async ({ page }) => {
  await bar(page).click();
  const options = dialog(page).getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.first()).toHaveText(/This Mac/);
  await expect(options.nth(1)).toHaveText(/VPS/);
  await expect(options.nth(1)).toHaveText(/ledge@vps/);
  // It opens on the connection in use, so Enter is "stay here" and moving
  // somewhere else costs a deliberate arrow.
  await expect(options.first()).toBeFocused();
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
});

// Losing a working session to a machine that is asleep would be the worse
// failure by far, so the refusal is the whole behavior here: the dialog stays,
// the reason shows, and the notes on screen are untouched.
test("a machine that will not answer costs nothing", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("option", { name: /VPS/ }).click();
  await expect(dialog(page).getByText(/host is down/)).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveText(/This Mac/);
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
});

// Adding is two steps because the second one is the security of the whole
// transport: Ledge pins a host key only after a person has read its
// fingerprint and said it is the one they expected (remote.md §4).
test("adding a server shows the host key's fingerprint before anything is pinned", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Laptop");
  await dialog(page).getByLabel("SSH destination").fill("dan@laptop");
  await dialog(page).getByRole("button", { name: "Continue" }).click();

  await expect(dialog(page).getByText("SHA256:harness+fake+key")).toBeVisible();
  // No "connect anyway": the only way forward says what it is agreeing to.
  await expect(dialog(page).getByRole("button", { name: "It Matches — Add" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "It Matches — Add" }).click();

  const options = dialog(page).getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(2)).toHaveText(/Laptop/);
  // Pinned, because a fingerprint was shown and accepted.
  await expect(options.nth(2)).toHaveText(/pinned/);
});

test("a host that does not answer is a sentence, not a spinner", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Ghost");
  await dialog(page).getByLabel("SSH destination").fill("nowhere.invalid");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page).getByText(/No answer from nowhere.invalid/)).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "It Matches — Add" })).toHaveCount(0);
});

// ⌫ on a focused row, the same remove verb the workspace strip uses — and the
// same refusal shape: the app must always have somewhere to work from.
test("⌫ removes a configured server, and refuses on the one in use", async ({ page }) => {
  await bar(page).click();
  const options = dialog(page).getByRole("option");
  await options.first().press("Backspace");
  await expect(dialog(page).getByText(/cannot be removed/)).toBeVisible();
  await expect(options).toHaveCount(2);

  await options.nth(1).press("Backspace");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText(/This Mac/);
});

// A wire that dropped (remote.md §7). The name in the bar is still the right
// machine; what changed is whether it can be reached, and an app that keeps
// taking keystrokes for a server it cannot reach looks like it is working.
test("a dropped connection says so, and says so again when it comes back", async ({ page }) => {
  await expect(bar(page)).toHaveAttribute("data-link", "live");
  await expect(bar(page)).not.toHaveText(/reconnecting/);

  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await expect(bar(page)).toHaveAttribute("data-link", "reconnecting");
  await expect(bar(page)).toHaveText(/reconnecting/);
  // Still the machine it always was: a drop is not a switch.
  await expect(bar(page)).toHaveText(/This Mac/);

  await page.evaluate(() => window.__harness.linkState("live", ""));
  await expect(bar(page)).toHaveAttribute("data-link", "live");
  await expect(bar(page)).not.toHaveText(/reconnecting/);
});

test("a connection that will not come back is disconnected, not reconnecting", async ({ page }) => {
  await page.evaluate(() => window.__harness.linkState("lost", "Lost the connection: host is down."));
  await expect(bar(page)).toHaveAttribute("data-link", "lost");
  await expect(bar(page)).toHaveText(/disconnected/);
  await expect(bar(page)).toHaveAttribute("title", /host is down/);
});
