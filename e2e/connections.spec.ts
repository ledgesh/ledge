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
  await dialog(page).getByLabel("SSH destination").fill("dev@laptop");
  await dialog(page).getByRole("button", { name: "Continue" }).click();

  await expect(dialog(page).getByText("SHA256:harness+fake+key")).toBeVisible();
  // No "connect anyway": the only way forward says what it is agreeing to.
  await expect(dialog(page).getByRole("button", { name: "It Matches, Add" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "It Matches, Add" }).click();

  const options = dialog(page).getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(2)).toHaveText(/Laptop/);
  // Pinned, because a fingerprint was shown and accepted.
  await expect(options.nth(2)).toHaveText(/pinned/);
});

// The password door (remote.md §4). The form's job is to ask for the secret
// once: a stored password cannot be read back on either client, so everything
// after the first save has to work with a field that is empty on purpose.
async function addWithPassword(page: Page, name = "Box") {
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill(name);
  await dialog(page).getByLabel("SSH destination").fill("ledge@box");
  await dialog(page).getByRole("radio", { name: "A password" }).check();
  await dialog(page).getByLabel("Password", { exact: true }).fill("hunter2");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await dialog(page).getByRole("button", { name: "It Matches, Add" }).click();
}

test("a server can be added with a password instead of a key", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Box");
  await dialog(page).getByLabel("SSH destination").fill("ledge@box");

  // One door's field at a time: no key is offered on a password connection, so
  // asking for a path would be asking for something with no effect.
  await expect(dialog(page).getByLabel("Key (optional)")).toBeVisible();
  await dialog(page).getByRole("radio", { name: "A password" }).check();
  await expect(dialog(page).getByLabel("Key (optional)")).toBeHidden();

  // Nothing to go on with until there is one, since a new connection has
  // nothing stored to fall back to.
  await expect(dialog(page).getByRole("button", { name: "Continue" })).toBeDisabled();
  await dialog(page).getByLabel("Password", { exact: true }).fill("hunter2");
  await expect(dialog(page).getByRole("button", { name: "Continue" })).toBeEnabled();
  await dialog(page).getByRole("button", { name: "Continue" }).click();

  // Still two steps. The host key is read and confirmed whichever door is used.
  await expect(dialog(page).getByText("SHA256:harness+fake+key")).toBeVisible();
  await dialog(page).getByRole("button", { name: "It Matches, Add" }).click();

  const options = dialog(page).getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(2)).toHaveText(/Box/);
  // Which door, on the row: it is otherwise invisible until a dial fails.
  await expect(options.nth(2)).toHaveText(/password/);
});

// Typed once. The field comes back empty and says what empty means, because
// the alternative is a form that cannot tell "leave it alone" from "erase it".
test("editing a password server does not ask for the password again", async ({ page }) => {
  await bar(page).click();
  await addWithPassword(page);
  await dialog(page).getByRole("button", { name: "Edit Box" }).click();
  const field = dialog(page).getByLabel(/^Password \(leave blank/);
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("");
  // And a rename saves in one step, with the field left alone.
  await dialog(page).getByLabel("Name").fill("Crate");
  await dialog(page).getByRole("button", { name: "Save" }).click();
  const options = dialog(page).getByRole("option");
  await expect(options.nth(2)).toHaveText(/Crate/);
  await expect(options.nth(2)).toHaveText(/password/);
});

// A connection that has never had one has nothing to keep, so the blank field
// is not an answer here and the form says so by refusing to save.
test("moving a server onto the password door has to be given a password", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Edit VPS" }).click();
  await dialog(page).getByRole("radio", { name: "A password" }).check();
  await expect(dialog(page).getByLabel("Password", { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Save" })).toBeDisabled();
  await dialog(page).getByLabel("Password", { exact: true }).fill("hunter2");
  await dialog(page).getByRole("button", { name: "Save" }).click();
  await expect(dialog(page).getByRole("option").nth(1)).toHaveText(/password/);
});

// A rename touches nothing about how the connection is made, so it saves in
// one step and the pin it already has stays its own.
test("a server can be renamed without being asked about its key again", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Edit VPS" }).click();
  await expect(dialog(page).getByLabel("Name")).toHaveValue("VPS");
  await expect(dialog(page).getByLabel("SSH destination")).toHaveValue("ledge@vps");
  await dialog(page).getByLabel("Name").fill("Frankfurt");
  await dialog(page).getByRole("button", { name: "Save" }).click();

  const options = dialog(page).getByRole("option");
  await expect(options.nth(1)).toHaveText(/Frankfurt/);
  await expect(options.nth(1)).toHaveText(/pinned/);
});

// A pin is a claim about one machine, so an address that moved to another one
// asks the same question adding did. The button says which of the two this is
// before it is pressed.
test("re-addressing a server onto another host asks for its fingerprint", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Edit VPS" }).click();
  // Same host, different account: nothing to re-pin.
  await dialog(page).getByLabel("SSH destination").fill("dev@vps");
  await expect(dialog(page).getByRole("button", { name: "Save" })).toBeVisible();

  await dialog(page).getByLabel("SSH destination").fill("ledge@frankfurt");
  await expect(dialog(page).getByRole("button", { name: "Save" })).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page).getByText("SHA256:harness+fake+key")).toBeVisible();
  await dialog(page).getByRole("button", { name: "It Matches, Save" }).click();

  await expect(dialog(page).getByRole("option").nth(1)).toHaveText(/ledge@frankfurt/);
});

// The port is its own field, not part of the address, and it is part of what
// gets pinned: known_hosts indexes a non-default port as `[host]:port`
// (shared/connections.ts).
test("a port is a field of its own, and it travels into the pin", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Box");
  await dialog(page).getByLabel("SSH destination").fill("ledge@box");
  await dialog(page).getByLabel("Port (optional)").fill("2222");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page).getByText("SHA256:harness+fake+key")).toBeVisible();
  await dialog(page).getByRole("button", { name: "It Matches, Add" }).click();
  await expect(dialog(page).getByRole("option", { name: /Box/ })).toBeVisible();
});

// A typo must not silently become 22 and connect to the wrong sshd.
test("a port that is not a port is refused before anything is dialled", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Box");
  await dialog(page).getByLabel("SSH destination").fill("ledge@box");
  await dialog(page).getByLabel("Port (optional)").fill("22x");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page).getByText(/1 to 65535/)).toBeVisible();
  await expect(dialog(page).getByText("SHA256:harness+fake+key")).toHaveCount(0);
});

// Blank is the ordinary answer and means "ssh decides", so it is not a typo and
// must not be treated as one.
test("a blank port adds without complaint", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Plain");
  await dialog(page).getByLabel("SSH destination").fill("ledge@plain");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page).getByText("SHA256:harness+fake+key")).toBeVisible();
});

// Moving a connection to another port on the same machine is moving it to
// another known_hosts entry, which can hold another key.
test("changing only the port asks for the fingerprint again", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Edit VPS" }).click();
  await expect(dialog(page).getByRole("button", { name: "Save" })).toBeVisible();
  await dialog(page).getByLabel("Port (optional)").fill("2222");
  await expect(dialog(page).getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(dialog(page).getByRole("button", { name: "Continue" })).toBeVisible();
});

test("a host that does not answer is a sentence, not a spinner", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Ghost");
  await dialog(page).getByLabel("SSH destination").fill("nowhere.invalid");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page).getByText(/No answer from nowhere.invalid/)).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "It Matches, Add" })).toHaveCount(0);
});

// ⌫ on a focused row, the same remove verb the workspace strip uses — and the
// same refusal shape: the app must always have somewhere to work from.
test("⌫ removes a configured server, and the local one has no such verb", async ({ page }) => {
  await bar(page).click();
  const options = dialog(page).getByRole("option");
  // The server in this process is not a record: there is nothing about it to
  // remove and nothing to edit, so neither control exists on its row.
  await expect(dialog(page).getByRole("button", { name: /Edit This Mac/ })).toHaveCount(0);
  await expect(dialog(page).getByRole("button", { name: /Remove This Mac/ })).toHaveCount(0);
  await options.first().press("Backspace");
  await expect(options).toHaveCount(2);

  await options.nth(1).press("Backspace");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText(/This Mac/);
});

// The row verb has no touch form (interactions.md §1a), so the same two verbs
// are controls on the row — present at rest rather than revealed by a hover a
// phone cannot perform.
test("a server is removable without a keyboard", async ({ page }) => {
  await bar(page).click();
  const options = dialog(page).getByRole("option");
  await dialog(page).getByRole("button", { name: "Remove VPS" }).click();
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

// The bar has one click and two verbs under it. Switching machines is the
// everyday one and the wrong one to offer at the moment the machine you are on
// cannot be reached: the switch reloads the page, so it is refused outright
// while anything is unsaved, and a chooser that opens only to say no would be
// the app's entire visible answer to being disconnected.
//
// The app dials on its own either way (remote.md §7), so this is never the only
// way back. It is for the person who can see their wifi return.
test("the bar reconnects while the link is down, and switches while it is up", async ({ page }) => {
  await bar(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__harness.reconnects())).toBe(0);

  await page.evaluate(() => window.__harness.linkState("lost", "Lost the connection: host is down."));
  await bar(page).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__harness.reconnects())).toBe(1);
  // A press with nothing to await must still answer for itself: the dial's
  // outcome arrives later as a link state, and without this the button reads as
  // dead every time the server is still unreachable.
  await expect(page.getByText(/Trying to reach This Mac/)).toBeVisible();
});

// And it is offered nowhere while the link is fine. A "Reconnect" that is
// present and inert on a working connection teaches nobody anything
// (interactions.md §8).
test("reconnect is absent from the palette until there is something to reconnect", async ({ page }) => {
  await page.keyboard.press("Shift+Meta+p");
  await page.keyboard.type("Reconnect");
  await expect(page.getByText("Reconnect", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.evaluate(() => window.__harness.linkState("lost", "Lost the connection: host is down."));
  await page.keyboard.press("Shift+Meta+p");
  await page.keyboard.type("Reconnect");
  await expect(page.getByText("Reconnect", { exact: true })).toBeVisible();
});

// Who else is on the machine (remote.md §7). It is in this bar because it is
// the same question one step further in — which machine, whether it can be
// reached, and who else is on it — and because the device named here is the one
// that can take a shell out from under you.
test("the bar names the other device on the server, and stops when it leaves", async ({ page }) => {
  // Nothing at all while you are alone, which is nearly always: a strip that
  // said "1 device" every time you opened the app would be noise in the one
  // place that has to stay readable at a glance.
  await expect(bar(page).locator("[data-presence]")).toHaveCount(0);

  await page.evaluate(() => window.__harness.presence([{ client: "phone-1", label: "iPhone" }]));
  await expect(bar(page).locator("[data-presence]")).toHaveText("iPhone");
  await expect(bar(page).locator("[data-presence]")).toHaveAttribute("title", /Also on this server: iPhone/);
  // Still the machine it always was: company is not a switch.
  await expect(bar(page)).toHaveText(/This Mac/);

  await page.evaluate(() => window.__harness.presence([]));
  await expect(bar(page).locator("[data-presence]")).toHaveCount(0);
});

test("past one other device the bar counts, and the names are a hover away", async ({ page }) => {
  await page.evaluate(() =>
    window.__harness.presence([
      { client: "phone-1", label: "iPhone" },
      { client: "mac-2", label: "Studio" },
      // A client that gave no name is still company: a script on the wire, or a
      // shell pumping frames. It is counted, and named as best it can be.
      { client: "script-1", label: "" },
    ]),
  );
  await expect(bar(page).locator("[data-presence]")).toHaveText("3 devices");
  await expect(bar(page).locator("[data-presence]")).toHaveAttribute("title", /iPhone, Studio, an unnamed device/);
});

// A wire that is down cannot report who else is up. Keeping the last list would
// mean naming a device that may have left while we were not connected to hear
// it; the server announces to everybody on the next arrival, which is this
// client's own reconnect.
test("a dropped connection stops claiming to know who else is here", async ({ page }) => {
  await page.evaluate(() => window.__harness.presence([{ client: "phone-1", label: "iPhone" }]));
  await expect(bar(page).locator("[data-presence]")).toHaveText("iPhone");

  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await expect(bar(page).locator("[data-presence]")).toHaveCount(0);
});

// New Window (remote.md §8a). The second window is another client in another
// webview, so nothing about it is visible from inside this page: what a spec
// can assert is that the verb is offered, that it asks the shell, and that
// asking twice asks twice — the rest belongs to the live probe (testing.md §6).
test("New Window asks the shell, once per invocation", async ({ page }) => {
  expect(await page.evaluate(() => window.__harness.windowOpens())).toBe(0);

  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("New Window");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.windowOpens())).toBe(1);

  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("New Window");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__harness.windowOpens())).toBe(2);
});

// ⌘N is New Note and stays New Note: the N family is spent, and a window is a
// bigger scope than the workspace holding ⇧⌘N (interactions.md §2).
test("New Window takes no chord", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+n");
  await page.keyboard.press("Meta+n");
  await page.keyboard.press("Alt+Meta+n");
  expect(await page.evaluate(() => window.__harness.windowOpens())).toBe(0);
});

// A phone shows one app at a time, so the verb is absent rather than present
// and silent (ios.md §4, lib/shell.ts multiWindow). Both halves in one case:
// the desktop assertion is what stops the phone one from passing because the
// palette never had the row under any shell.
test("a shell with one window does not offer it, and one with two does", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("New Window");
  await expect(page.getByText("New Window")).toHaveCount(1);

  await page.goto("/harness.html?shell=ios");
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("New Window");
  await expect(page.getByText("New Window")).toHaveCount(0);
});

// The freeze this dialog used to have, from both doors onto it.
//
// A refusal and a rejection are different failures: Bun answering "no" is a
// sentence, and Bun not answering at all — outliving the view's
// maxRequestTime, or dying — is a thrown thing. Every action here sets `busy`
// before it asks and used to clear it only on the way back from an answer, so
// a rejection left the flag set forever. That disabled every control in the
// dialog AND the guard at the top of switchTo, which swallows further clicks
// without a trace: from the outside, an app that hung on this window.
test("a request that never comes back is a sentence too, and the dialog stays usable", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Wedged");
  await dialog(page).getByLabel("SSH destination").fill("ledge@wedged");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page).getByText(/RPC request timed out/)).toBeVisible();
  // The whole claim: the button that started it is live again, so this is
  // recoverable by the person looking at it rather than by relaunching.
  await expect(dialog(page).getByRole("button", { name: "Continue" })).toBeEnabled();
});

test("a switch whose answer never arrives leaves the list clickable", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Wedged");
  await dialog(page).getByLabel("SSH destination").fill("ledge@wedged-later");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await dialog(page).getByRole("button", { name: "It Matches, Add" }).click();

  const row = dialog(page).getByRole("option", { name: /Wedged/ });
  await row.click();
  await expect(dialog(page).getByText(/RPC request timed out/)).toBeVisible();
  await expect(row).toBeEnabled();
  // And the guard clears with it: a second click is dispatched rather than
  // dropped, which is what "usable" has to mean for a row whose whole verb is
  // being clicked.
  await row.click();
  await expect(dialog(page).getByText(/RPC request timed out/)).toBeVisible();
});
