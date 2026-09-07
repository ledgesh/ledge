// These specs cover the connection bar and its chooser: which machine the
// notes are on (remote.md §8). The hazard is running a command on the wrong
// machine. They check legibility and refusals: the name stays on screen, a
// connection that will not open costs nothing, and the local server cannot be
// removed. A successful switch reloads the page (lib/connections.ts
// selectConnection), so no spec here takes one.
import { expect, test, type Page } from "@playwright/test";

const bar = (page: Page) => page.locator("[data-connection]");
const switcher = (page: Page) => page.locator("[data-switch]");
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
  // The dialog opens focused on the connection in use, so Enter stays here and
  // moving somewhere else takes an arrow key first.
  await expect(options.first()).toBeFocused();
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
});

// A machine that is asleep must not end the session already open. This checks
// the refusal: the dialog stays open, the reason shows, and the notes on
// screen are untouched.
test("a machine that will not answer costs nothing", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("option", { name: /VPS/ }).click();
  await expect(dialog(page).getByText(/host is down/)).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveText(/This Mac/);
  await expect(page.locator('[data-target-kind="note"]', { hasText: "Alpha" })).toBeVisible();
});

// Adding takes two steps. Ledge pins a host key only after a person has read
// its fingerprint and confirmed it is the one they expected (remote.md §4).
test("adding a server shows the host key's fingerprint before anything is pinned", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Laptop");
  await dialog(page).getByLabel("SSH destination").fill("dev@laptop");
  await dialog(page).getByRole("button", { name: "Continue" }).click();

  await expect(dialog(page).getByText("SHA256:harness+fake+key")).toBeVisible();
  // No "connect anyway" button. The button that continues says what accepting
  // the key means.
  await expect(dialog(page).getByRole("button", { name: "It Matches, Add" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "It Matches, Add" }).click();

  const options = dialog(page).getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(2)).toHaveText(/Laptop/);
  // Pinned, because a fingerprint was shown and accepted.
  await expect(options.nth(2)).toHaveText(/pinned/);
});

// Adds a server on the password door (remote.md §4). The form asks for the
// password once. A stored password cannot be read back on either client, so
// every edit after the first save works with an empty field.
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

  // One door's fields at a time. A password connection uses no key, so the key
  // path field is hidden rather than asking for something with no effect.
  await expect(dialog(page).getByLabel("Key (optional)")).toBeVisible();
  await dialog(page).getByRole("radio", { name: "A password" }).check();
  await expect(dialog(page).getByLabel("Key (optional)")).toBeHidden();

  // Continue stays disabled until a password is typed. A new connection has
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
  // The row names the password door. A password connection whose stored secret
  // is gone looks like a key connection until it is dialled
  // (ConnectionPicker.tsx).
  await expect(options.nth(2)).toHaveText(/password/);
});

// The password is typed once. The field comes back empty, and its label says
// that blank keeps the stored password (ConnectionPicker.tsx typedPassword).
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

// A connection moved onto the password door has no stored password to keep, so
// a blank field is not an answer here and Save stays disabled.
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

// A rename changes nothing about how the connection is made, so it saves in
// one step and keeps the pin it already has.
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
// asks the same question adding did. The button reads Continue when the pin has
// to be taken again, and Save when it does not.
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

// The port is a field of its own, not part of the address. A non-default port
// gets its own known_hosts entry, `[host]:port` (shared/connections.ts
// knownHostsHost), so it travels into the pin. This spec checks only that the
// port is accepted and the server is added; nothing here reads the pin back.
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

// ⌫ on a focused row, the same remove verb the workspace strip uses. The local
// row has no such verb at all: its onKeyDown returns on `local`, and neither
// row button is rendered (ConnectionPicker.tsx). interactions.md §4-1 counts
// the local server among the three refusals that keep the app somewhere it can
// work from.
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
// are also buttons on the row. They are drawn at rest rather than revealed by
// a hover, which a phone cannot perform.
test("a server is removable without a keyboard", async ({ page }) => {
  await bar(page).click();
  const options = dialog(page).getByRole("option");
  await dialog(page).getByRole("button", { name: "Remove VPS" }).click();
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText(/This Mac/);
});

// A wire that dropped (remote.md §7). The bar still names the right machine.
// Only whether it can be reached has changed. An app that keeps taking
// keystrokes for a server it cannot reach looks like it is working.
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

// The bar's wide button is Reconnect while the machine cannot be reached, and
// Switch while it can (interactions.md §4-1). After a goodbye the server did
// not expect to take back, nothing dials on its own and the press is the only
// thing that will (shared/transport.ts give).
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
  // The press shows a notice because nothing waits on the dial: its outcome
  // arrives later as a link state. Without the notice the button reads as dead
  // every time the server is still unreachable.
  await expect(page.getByText(/Trying to reach This Mac/)).toBeVisible();
});

// Reconnect takes the wide half, and the switcher stays beside it as the
// narrow half (ConnectionBar.tsx). It did not, once: one button held one verb,
// so a window that could not reconnect could not leave either, and the only
// route to the chooser was the palette and the File menu (interactions.md
// §4-1).
test("and the switcher is still reachable from the bar while the link is down", async ({ page }) => {
  await expect(switcher(page)).toHaveCount(0);

  await page.evaluate(() => window.__harness.linkState("lost", "Lost the connection: host is down."));
  await switcher(page).click();
  await expect(dialog(page)).toBeVisible();
  // The chooser, and nothing else: the half that dials is the other one.
  expect(await page.evaluate(() => window.__harness.reconnects())).toBe(0);

  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__harness.linkState("live", ""));
  await expect(switcher(page)).toHaveCount(0);
});

// Reconnect is offered nowhere while the link is fine. A Reconnect that is
// present and inert on a working connection teaches nothing
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

// Who else is on the machine (remote.md §7), the bar's third question after
// which machine and whether it can be reached. Any device on that list can
// take a note's shell from this one (interactions.md §4-2).
test("the bar names the other device on the server, and stops when it leaves", async ({ page }) => {
  // Nothing is drawn while nobody else is connected, which is nearly always.
  // "1 device" on every launch would be noise in a strip that has to stay
  // readable at a glance.
  await expect(bar(page).locator("[data-presence]")).toHaveCount(0);

  await page.evaluate(() => window.__harness.presence([{ client: "phone-1", label: "iPhone" }]));
  await expect(bar(page).locator("[data-presence]")).toHaveText("iPhone");
  await expect(bar(page).locator("[data-presence]")).toHaveAttribute("title", /Also on this server: iPhone/);
  // Another device arriving does not change which machine the notes are on.
  await expect(bar(page)).toHaveText(/This Mac/);

  await page.evaluate(() => window.__harness.presence([]));
  await expect(bar(page).locator("[data-presence]")).toHaveCount(0);
});

test("past one other device the bar counts, and the names are a hover away", async ({ page }) => {
  await page.evaluate(() =>
    window.__harness.presence([
      { client: "phone-1", label: "iPhone" },
      { client: "mac-2", label: "Studio" },
      // A shell with no name to give sends an empty label (shared/wire.ts). It
      // still counts toward the number, and shows in the hover list as "an
      // unnamed device" rather than being left out.
      { client: "script-1", label: "" },
    ]),
  );
  await expect(bar(page).locator("[data-presence]")).toHaveText("3 devices");
  await expect(bar(page).locator("[data-presence]")).toHaveAttribute("title", /iPhone, Studio, an unnamed device/);
});

// A wire that is down cannot report who else is up. Keeping the last list would
// name a device that may have left while this client was disconnected. The list
// comes back on the next reconnect. A reconnect is an arrival, and a server
// announces presence on every arrival (remote.md §7).
test("a dropped connection stops claiming to know who else is here", async ({ page }) => {
  await page.evaluate(() => window.__harness.presence([{ client: "phone-1", label: "iPhone" }]));
  await expect(bar(page).locator("[data-presence]")).toHaveText("iPhone");

  await page.evaluate(() => window.__harness.linkState("reconnecting", "The connection dropped. Reconnecting…"));
  await expect(bar(page).locator("[data-presence]")).toHaveCount(0);
});

// New Window (remote.md §8a). The second window is another client in another
// webview, so nothing about it is visible from inside this page. A spec can
// assert only that the verb is offered, that it asks the shell, and that asking
// twice asks twice. The rest belongs to the live probe (testing.md §6).
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
// and silent (ios.md §11, lib/shell.ts multiWindow). The desktop half is
// asserted in the same test: a palette missing New Window under every shell
// would satisfy the ios assertion on its own.
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

// This dialog used to freeze, and two things could freeze it: the form's
// Continue button, and a click on a row. An RPC can refuse with a sentence or
// reject, and a rejection is Bun taking longer than the view's maxRequestTime
// or dying. Every action sets `busy` before it asks and used to clear it only
// on an answer, so a rejection left `busy` set: every control here disabled,
// and the guard at the top of switchTo dropping clicks without a trace.
test("a request that never comes back is a sentence too, and the dialog stays usable", async ({ page }) => {
  await bar(page).click();
  await dialog(page).getByRole("button", { name: "Add Server…" }).click();
  await dialog(page).getByLabel("Name").fill("Wedged");
  await dialog(page).getByLabel("SSH destination").fill("ledge@wedged");
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page).getByText(/RPC request timed out/)).toBeVisible();
  // The button that started it is enabled again, so the dialog recovers where
  // it stands rather than by relaunching the app.
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
  // The guard at the top of switchTo clears with `busy`, so a second click is
  // dispatched rather than dropped. Clicking is the row's only verb, so an
  // enabled row that swallowed clicks would still be stuck.
  await row.click();
  await expect(dialog(page).getByText(/RPC request timed out/)).toBeVisible();
});
