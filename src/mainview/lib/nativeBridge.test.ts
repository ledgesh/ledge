// The page's half of the iOS bridge (ios.md §2). Everything here is `post` in
// and `deliver` out, which is the whole reason the module was written that
// way: the protocol between a webview and a Swift shell is testable in Bun,
// and only the three lines that touch WebKit are not.
import { describe, expect, test } from "bun:test";
import { CLIENT_METHODS, fromBase64, REQUEST_METHODS, toBase64, type RequestClient } from "../../shared/wire";
import {
  focusReporter,
  iosClientMethods,
  nativeOverlay,
  nativeShell,
  SHELL_CALLS,
  type BarFace,
  type ToShell,
} from "./nativeBridge";

function recorder() {
  const sent: ToShell[] = [];
  const shell = nativeShell((msg) => sent.push(msg));
  // Answer the pending call whose id is `id`, the way Swift does.
  const reply = (id: number, r: unknown) => shell.deliver({ t: "reply", id, r });
  const fail = (id: number, e: string) => shell.deliver({ t: "fail", id, e });
  // The dial handshake, so a test that only cares about bytes can skip past it.
  const answer = (m: string, r: unknown) => {
    // The LAST one: a reconnect dials again, and answering the first @open a
    // second time would settle nothing and hang the test.
    const call = sent.filter((msg) => msg.t === "call" && msg.m === m).at(-1);
    reply((call as { id: number }).id, r);
  };
  const greeted = async (destination = "ledge@192.168.1.9") => {
    const asking = shell.hello();
    answer("@hello", {
      client: "device-1",
      label: "iPhone",
      destination,
      key: "restrict,command=… ecdsa-sha2-nistp256 AAAA iphone",
    });
    return asking;
  };
  const opened = async (gen: number) => {
    const dialing = shell.dial();
    answer("@open", { gen });
    return dialing;
  };
  return { sent, shell, reply, fail, greeted, opened };
}

describe("the native call channel", () => {
  test("posts a call and resolves on the shell's reply", async () => {
    const { sent, shell, reply } = recorder();
    const answer = shell.call("clipboard.read", {});
    expect(sent).toEqual([{ t: "call", id: 1, m: "clipboard.read", p: {} }]);
    reply(1, "copied");
    expect(await answer).toBe("copied");
  });

  test("rejects in the shell's own words", async () => {
    const { shell, fail } = recorder();
    const answer = shell.call("link.open", { url: "x" });
    fail(1, "there is nothing that opens that");
    expect(answer).rejects.toThrow("there is nothing that opens that");
  });

  test("a reply to an id nobody is waiting on is ignored", () => {
    const { shell } = recorder();
    expect(() => shell.deliver({ t: "reply", id: 99, r: null })).not.toThrow();
  });

  test("who we are and where we point is asked once, before any socket", async () => {
    const { sent, shell, greeted } = recorder();
    expect(shell.destination()).toBe("");
    // The device's four facts together, because all four are needed before a
    // connection exists: the id keys the layout, the label names this phone on
    // the other clients' screens, the destination names the machine, and the key
    // line is what a NEW server has to be given (§4).
    expect(await greeted("dev@mac.local")).toEqual({
      client: "device-1",
      label: "iPhone",
      destination: "dev@mac.local",
      key: "restrict,command=… ecdsa-sha2-nistp256 AAAA iphone",
    });
    expect(shell.destination()).toBe("dev@mac.local");
    // The layout is keyed by client id (remote.md §5), so the id has to be in
    // hand before the first dial rather than after it.
    expect(sent[0]).toEqual({ t: "call", id: 1, m: "@hello", p: {} });
  });

  test("a log line never becomes a failure", () => {
    const { sent, shell } = recorder();
    expect(() => shell.log("boot in 412ms")).not.toThrow();
    expect(sent.at(-1)).toEqual({ t: "call", id: 1, m: "@log", p: { text: "boot in 412ms" } });
  });

  test("every call the overlay makes is a name the shell was told about", () => {
    // SHELL_CALLS is the Swift switch's cases. A name here that is not there is
    // a call nothing answers, which is a hang rather than an error.
    expect(new Set(SHELL_CALLS).size).toBe(SHELL_CALLS.length);
    expect([...SHELL_CALLS].every((c) => c.startsWith("@") || c.includes("."))).toBe(true);
  });
});

describe("the byte stream", () => {
  test("writes become base64 frames and delivered frames become bytes", async () => {
    const { sent, shell, opened } = recorder();
    const wire = await opened(1);
    const seen: Uint8Array[] = [];
    wire.onData = (chunk) => seen.push(chunk);

    wire.write(new Uint8Array([1, 2, 3]));
    expect(sent.at(-1)).toEqual({ t: "frame", b: toBase64(new Uint8Array([1, 2, 3])) });

    shell.deliver({ t: "frame", gen: 1, b: toBase64(new Uint8Array([9, 8])) });
    expect(seen).toEqual([new Uint8Array([9, 8])]);
  });

  test("bytes that beat the reader are held, not dropped", async () => {
    const { shell, opened } = recorder();
    const wire = await opened(1);
    // Between `dial()` resolving and clientConnection attaching its reader is
    // two statements, and the server's hello is already on its way.
    shell.deliver({ t: "frame", gen: 1, b: toBase64(new Uint8Array([7])) });
    const seen: Uint8Array[] = [];
    wire.onData = (chunk) => seen.push(chunk);
    expect(seen).toEqual([new Uint8Array([7])]);
  });

  test("closing asks the shell to close that generation", async () => {
    const { sent, opened } = recorder();
    const wire = await opened(4);
    wire.write(new Uint8Array([0]));
    wire.close();
    expect(sent.at(-1)).toEqual({ t: "call", id: 2, m: "@close", p: { gen: 4 } });
  });

  test("a hangup ends the stream", async () => {
    const { shell, opened } = recorder();
    const wire = await opened(1);
    let ended = 0;
    wire.onData = () => {};
    wire.onClose = () => (ended += 1);
    shell.deliver({ t: "closed", gen: 1 });
    expect(ended).toBe(1);
  });
});

// The accessory bar's half of the bridge (ios.md §7). Swift sends a command
// id; the page hands it to the registry. Nothing here knows what any of the
// ids mean, and that is the contract under test.
describe("a button on the keyboard bar", () => {
  test("arrives as the command id Swift sent, verbatim", () => {
    const { shell } = recorder();
    const ran: string[] = [];
    shell.onVerb((id) => ran.push(id));
    shell.deliver({ t: "verb", id: "format.bold" });
    shell.deliver({ t: "verb", id: "format.indent" });
    expect(ran).toEqual(["format.bold", "format.indent"]);
  });

  test("before anything subscribes, it is dropped rather than thrown", () => {
    // The window between the page loading and bootView registering the
    // dispatcher. A tap in it means nothing — there is no editor yet — and a
    // throw here would land in `deliver`, which Swift calls from
    // evaluateJavaScript and cannot handle.
    const { shell } = recorder();
    expect(() => shell.deliver({ t: "verb", id: "format.bold" })).not.toThrow();
  });

  test("a verb is not a reply, and settles no pending call", async () => {
    // Both cross the same channel. An id collision between the two would be a
    // native call resolving with a command name.
    const { shell, sent } = recorder();
    let settled = false;
    void shell.call("clipboard.read", {}).then(() => (settled = true));
    shell.deliver({ t: "verb", id: "format.bold" });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(sent.at(-1)).toEqual({ t: "call", id: 1, m: "clipboard.read", p: {} });
  });

  test("and the bar is told which of its faces to wear", () => {
    const { shell, sent } = recorder();
    shell.focus("note");
    expect(sent.at(-1)).toEqual({ t: "call", id: 1, m: "@focus", p: { over: "note" } });
    shell.focus("run");
    expect(sent.at(-1)).toEqual({ t: "call", id: 2, m: "@focus", p: { over: "run" } });
    shell.focus("none");
    expect(sent.at(-1)).toEqual({ t: "call", id: 3, m: "@focus", p: { over: "none" } });
  });

  // The run's face sends key names, not command ids, and lands somewhere else
  // entirely (editor/inlineTerm.ts). One channel, two vocabularies, and neither
  // may arrive as the other.
  test("a key is not a verb", () => {
    const { shell } = recorder();
    const verbs: string[] = [];
    const keys: string[] = [];
    shell.onVerb((id) => verbs.push(id));
    shell.onKey((k) => keys.push(k));
    shell.deliver({ t: "key", k: "ctrlC" });
    shell.deliver({ t: "verb", id: "format.bold" });
    expect(keys).toEqual(["ctrlC"]);
    expect(verbs).toEqual(["format.bold"]);
  });
});

// The filter in front of that call. Focus events come in pairs and the editor
// keeps focus across most of them; what the shell needs is the transitions.
describe("what the keyboard is over, reported only when it changes", () => {
  test("the steady state costs nothing", () => {
    const told: BarFace[] = [];
    const report = focusReporter((over) => told.push(over));
    report("note");
    report("note");
    report("note");
    expect(told).toEqual(["note"]);
  });

  test("a page that has focused nothing yet says nothing", () => {
    // The shell's own state starts at "none" and a reload resets it, so an
    // opening "none" would be a bridge call that changes nothing — and, worse,
    // a reloadInputViews on a keyboard that is not up.
    const told: BarFace[] = [];
    const report = focusReporter((over) => told.push(over));
    report("none");
    expect(told).toEqual([]);
  });

  test("the editor to the search box, and back", () => {
    const told: BarFace[] = [];
    const report = focusReporter((over) => told.push(over));
    report("note"); // a tap in the note
    report("none"); // the overlay's input takes it
    report("none"); // the focusout and the focusin both fired
    report("note"); // the overlay closed and the editor has it again
    expect(told).toEqual(["note", "none", "note"]);
  });

  // The move with no blur in the middle: a run takes the keyboard from the
  // prose it is running under, and both surfaces are in the same editor. A
  // filter that only knew "focused or not" would report nothing at all here,
  // and the bar would keep offering Bold to a program waiting for a password.
  test("the note to the run it started, and back", () => {
    const told: BarFace[] = [];
    const report = focusReporter((over) => told.push(over));
    report("note");
    report("run");
    report("run");
    report("note");
    expect(told).toEqual(["note", "run", "note"]);
  });
});

// The reason `gen` exists. A reconnect dials while the previous socket's
// obituary is still crossing the bridge, and both of these would otherwise
// land on the connection that just replaced it.
describe("a superseded socket cannot speak for the live one", () => {
  test("its bytes are dropped", async () => {
    const { shell, opened } = recorder();
    await opened(1);
    const second = await opened(2);
    const seen: Uint8Array[] = [];
    second.onData = (chunk) => seen.push(chunk);
    shell.deliver({ t: "frame", gen: 1, b: toBase64(new Uint8Array([1])) });
    expect(seen).toEqual([]);
    shell.deliver({ t: "frame", gen: 2, b: toBase64(new Uint8Array([2])) });
    expect(seen).toEqual([new Uint8Array([2])]);
  });

  test("its close does not hang up the live one", async () => {
    const { shell, opened } = recorder();
    await opened(1);
    const second = await opened(2);
    let ended = 0;
    second.onData = () => {};
    second.onClose = () => (ended += 1);
    shell.deliver({ t: "closed", gen: 1 });
    expect(ended).toBe(0);
    shell.deliver({ t: "closed", gen: 2 });
    expect(ended).toBe(1);
  });
});

// --- the overlay -------------------------------------------------------------

/**
 * A server that answers nothing: reaching it is the failure under test.
 *
 * A real map over every method rather than a Proxy, because the overlay spreads
 * what it is given and a Proxy's methods are not own properties — a fake that
 * disappeared under a spread would fail for a reason the code does not have.
 */
function noServer(extra: Partial<RequestClient> = {}): RequestClient {
  return {
    ...(Object.fromEntries(
      REQUEST_METHODS.map((m) => [
        m,
        async () => {
          throw new Error(`${m} reached the wire`);
        },
      ]),
    ) as unknown as RequestClient),
    ...extra,
  };
}

function overlay(
  calls: (m: string, p: unknown) => Promise<unknown>,
  requests = noServer(),
  recheck: () => void = () => {},
): RequestClient {
  return nativeOverlay(
    { requests, recheck },
    { call: (m, p) => calls(m, p), destination: () => "dev@mac.local" },
    "0.1.0-server",
  );
}

interface StoredServer {
  id: string;
  name: string;
  destination: string;
  /** Where sshd listens, or 0 for the default (shared/connections.ts). */
  port: number;
  hostKey: string;
  /** Which door (remote.md §4). The password is never in the list: it goes to
   * the phone's keychain by its own call, which `withServers` records below. */
  auth: "key" | "password";
}

/**
 * The phone's stored list, driven the way Swift drives it.
 *
 * Three calls are the whole of what that end persists
 * (ios/Sources/ShellConfig.swift), so a fake holding them in a variable
 * exercises every rule there is about adding, renaming and removing — because
 * every one of those rules is in the overlay, on purpose, beside the Mac's in
 * bun/connectionManager.ts rather than a second time in Swift.
 */
function withServers(servers: StoredServer[], selected = servers[0]?.id ?? "") {
  // `passwords` is the phone's keychain, which no reply ever reads back: what
  // a test can see is what was PUT there, which is the same thing the page can
  // see (remote.md §4).
  const state = { servers, selected, passwords: new Map<string, string>() };
  const probed: string[] = [];
  const o = overlay(async (m, p) => {
    if (m === "servers.list") return { servers: state.servers, selected: state.selected };
    if (m === "servers.password") {
      const { id, password } = p as { id: string; password: string | null };
      if (password === null) state.passwords.delete(id);
      else state.passwords.set(id, password);
      return { ok: true };
    }
    if (m === "servers.save") {
      const saved = p as { servers: StoredServer[]; selected: string };
      state.servers = saved.servers;
      state.selected = saved.selected;
      return { ok: true };
    }
    if (m === "servers.probe") {
      const asked = p as { destination: string; port: number };
      probed.push(asked.port ? `${asked.destination}:${asked.port}` : asked.destination);
      return { hostKey: "ssh-ed25519 AAAAnew", fingerprint: "SHA256:new+key", keyType: "ssh-ed25519", error: "" };
    }
    return null;
  });
  return { state, probed, o };
}

const VPS: StoredServer = { id: "s1", name: "VPS", destination: "ledge@vps", port: 0, hostKey: "ssh-ed25519 AAAAvps", auth: "key" };
const PI: StoredServer = { id: "s2", name: "Pi", destination: "dev@pi.local", port: 0, hostKey: "ssh-ed25519 AAAApi", auth: "key" };

describe("the client overlay", () => {
  test("answers exactly the methods a server refuses", () => {
    expect(iosClientMethods().sort()).toEqual([...CLIENT_METHODS].sort());
  });

  test("the pasteboard and the browser go to the shell, not the wire", async () => {
    const asked: string[] = [];
    const o = overlay(async (m) => {
      asked.push(m);
      if (m === "clipboard.read") return "text";
      if (m === "clipboard.readRich") return { text: "text", html: "<b>text</b>" };
      return { ok: true };
    });
    expect(await o.clipboardRead({})).toEqual({ text: "text" });
    expect(await o.clipboardReadRich({})).toEqual({ text: "text", html: "<b>text</b>" });
    expect(await o.clipboardWrite({ text: "x" })).toEqual({ ok: true });
    expect(await o.linkOpen({ url: "https://example.com" })).toEqual({ ok: true });
    expect(asked).toEqual(["clipboard.read", "clipboard.readRich", "clipboard.write", "link.open"]);
  });

  test("a menu bar that does not exist is answered here", async () => {
    const asked: string[] = [];
    const o = overlay(async (m) => {
      asked.push(m);
      return null;
    });
    expect(await o.menuSet({ items: [{ label: "File" }] })).toEqual({ ok: true });
    // Not even the shell: there is nothing on a phone for it to hand this to.
    expect(asked).toEqual([]);
  });

  test("a pasted image is read here and named there", async () => {
    const png = toBase64(new Uint8Array([137, 80, 78, 71]));
    const wrote: unknown[] = [];
    const o = overlay(async () => png, noServer({ assetWrite: async (p) => (wrote.push(p), { src: ".ledge-assets/1.png" }) }));
    expect(await o.assetPaste({ root: "/notes", notePath: "/notes/a.md" })).toEqual({ src: ".ledge-assets/1.png" });
    // The bytes cross; the NAME comes back. The client never names a file.
    expect(wrote).toEqual([{ root: "/notes", notePath: "/notes/a.md", dataB64: png }]);
    expect(fromBase64(png)).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  test("no image on the pasteboard costs the server nothing", async () => {
    // noServer() throws on assetWrite, so this passing IS the assertion.
    expect(await overlay(async () => "").assetPaste({ root: "/notes", notePath: "/notes/a.md" })).toEqual({ src: null });
  });

  test("the connection list is this phone's own, and the selection is what is served", async () => {
    const { o } = withServers([VPS, PI], PI.id);
    const status = await o.connectionList({});
    expect(status.connections.map((c) => c.name)).toEqual(["VPS", "Pi"]);
    expect(status.active).toBe(PI.id);
    expect(status.wanted).toBe(PI.id);
    // No boot-time fallback to report: a phone with no reachable server never
    // renders this at all, it shows ios.tsx's sentence instead.
    expect(status.error).toBe("");
    // Facts about how a phone connects, not placeholders: the host key was
    // pinned when the server was added, and the client key has no path because
    // it is in the Secure Enclave (ios.md §4).
    expect(status.connections[0]).toMatchObject({ pinned: true, keyPath: "" });
    // The SERVER's build, not the client's: the chrome shows what it reached.
    expect(status.build).toBe("0.1.0-server");
  });

  test("a record whose pin was dropped is listed, and listed as unpinned", async () => {
    const { o } = withServers([{ ...VPS, hostKey: "" }]);
    expect((await o.connectionList({})).connections[0]).toMatchObject({ name: "VPS", pinned: false });
  });

  test("adding a server leaves the one being used alone", async () => {
    const { state, o } = withServers([VPS]);
    const { id, error } = await o.connectionAdd({
      name: "Pi",
      destination: "dev@pi.local",
      port: 0,
      keyPath: "",
      auth: "key",
      password: "",
      hostKey: "ssh-ed25519 AAAApi",
    });
    expect(error).toBe("");
    expect(state.servers.map((s) => s.name)).toEqual(["VPS", "Pi"]);
    expect(state.selected).toBe(VPS.id);
    expect(id).not.toBe("");
    expect(id).not.toBe(VPS.id);
  });

  // The same predicate the Mac applies, in the same words: what a text field
  // becomes is ssh's argv, and a destination starting with "-" is an option.
  test("what could not be an ssh destination never reaches the store", async () => {
    const { state, o } = withServers([VPS]);
    expect((await o.connectionAdd({ name: "X", destination: "-oProxyCommand=x", port: 0,
      keyPath: "", auth: "key", password: "", hostKey: "" })).error)
      .toContain("not an ssh destination");
    expect((await o.connectionAdd({ name: " ", destination: "dev@pi", port: 0,
      keyPath: "", auth: "key", password: "", hostKey: "" })).error)
      .toContain("name");
    expect(state.servers).toHaveLength(1);
  });

  test("switching stores the selection, and choosing the one in use is not a refusal", async () => {
    const { state, o } = withServers([VPS, PI], VPS.id);
    expect(await o.connectionSelect({ id: PI.id })).toEqual({ ok: true, error: "" });
    expect(state.selected).toBe(PI.id);
    // The ladder gives up for good when a restarted server answers with a new
    // instance (shared/transport.ts), and choosing the connection again is what
    // rebuilds from boot — on a phone the only recovery there is, so a refusal
    // would be an app that stays dead until it is force-quit.
    expect(await o.connectionSelect({ id: PI.id })).toEqual({ ok: true, error: "" });
    expect((await o.connectionSelect({ id: "elsewhere" })).ok).toBe(false);
  });

  test("a rename keeps the pin and the address", async () => {
    const { state, o } = withServers([VPS]);
    expect(await o.connectionUpdate({ ...VPS, name: "Frankfurt", port: 0,
      keyPath: "", auth: "key", password: null, hostKey: null })).toEqual({
      ok: true,
      error: "",
    });
    expect(state.servers[0]).toEqual({ ...VPS, name: "Frankfurt" });
  });

  // The account is not what a host key belongs to, so this one saves in a step.
  test("changing only the account keeps the pin", async () => {
    const { state, o } = withServers([VPS]);
    const res = await o.connectionUpdate({ ...VPS, destination: "dev@vps", port: 0,
      keyPath: "", auth: "key", password: null, hostKey: null });
    expect(res).toEqual({ ok: true, error: "" });
    expect(state.servers[0]).toMatchObject({ destination: "dev@vps", hostKey: VPS.hostKey });
  });

  // The password door (remote.md §4). The rules are this file's, beside the
  // Mac's in bun/connectionStore.ts: there is one right answer to "may this be
  // stored" and it should not be written twice in two languages.
  test("a password goes to the keychain by its own call, and never into the list", async () => {
    const { state, o } = withServers([VPS]);
    const { id, error } = await o.connectionAdd({
      name: "Pi",
      destination: "dev@pi.local",
      port: 0,
      keyPath: "",
      auth: "password",
      password: "hunter2",
      hostKey: "ssh-ed25519 AAAApi",
    });
    expect(error).toBe("");
    expect(state.passwords.get(id)).toBe("hunter2");
    // The record says which door and nothing more: the list is handed back to
    // Swift on every rename, and a credential in it would cross the bridge
    // every time.
    expect(JSON.stringify(state.servers)).not.toContain("hunter2");
    expect(state.servers.find((server) => server.id === id)).toMatchObject({ auth: "password" });
  });

  // askpass on a Mac and NIOSSH on a phone both take one line, so both refuse
  // the same passwords.
  test("a password neither client could deliver is refused", async () => {
    const { state, o } = withServers([VPS]);
    for (const password of ["", "two\nlines"]) {
      const res = await o.connectionAdd({
        name: "Pi",
        destination: "dev@pi.local",
        port: 0,
        keyPath: "",
        auth: "password",
        password,
        hostKey: "ssh-ed25519 AAAApi",
      });
      expect(res.id).toBe("");
      expect(res.error).not.toBe("");
    }
    expect(state.servers).toHaveLength(1);
    expect(state.passwords.size).toBe(0);
  });

  test("a rename keeps the stored password and sends nothing", async () => {
    const { state, o } = withServers([{ ...VPS, auth: "password" }]);
    state.passwords.set(VPS.id, "hunter2");
    const res = await o.connectionUpdate({
      ...VPS,
      name: "Frankfurt",
      port: 0,
      keyPath: "",
      auth: "password",
      password: null,
      hostKey: null,
    });
    expect(res).toEqual({ ok: true, error: "" });
    expect(state.passwords.get(VPS.id)).toBe("hunter2");
  });

  test("moving onto the door with nothing stored is refused, and onto it with one is not", async () => {
    const { state, o } = withServers([VPS]);
    const fields = { ...VPS, port: 0, keyPath: "", auth: "password" as const, hostKey: null };
    expect((await o.connectionUpdate({ ...fields, password: null })).error).toContain("no password stored");
    expect(state.servers[0]!.auth).toBe("key");
    expect(await o.connectionUpdate({ ...fields, password: "hunter2" })).toEqual({ ok: true, error: "" });
    expect(state.servers[0]!.auth).toBe("password");
    expect(state.passwords.get(VPS.id)).toBe("hunter2");
  });

  test("moving off the door forgets the password", async () => {
    const { state, o } = withServers([{ ...VPS, auth: "password" }]);
    state.passwords.set(VPS.id, "hunter2");
    const res = await o.connectionUpdate({ ...VPS, port: 0, keyPath: "", auth: "key", password: null, hostKey: null });
    expect(res).toEqual({ ok: true, error: "" });
    expect(state.passwords.size).toBe(0);
    expect(state.servers[0]!.auth).toBe("key");
  });

  // The pin here is a key and no hostname — there is no known_hosts file on a
  // phone for one to index — so nothing about it says which machine it came
  // from. Carrying it to another address would fail every later dial with a
  // message about a CHANGED host key.
  test("an address that moved to another host has to be pinned again", async () => {
    const { state, o } = withServers([VPS]);
    const refused = await o.connectionUpdate({ ...VPS, destination: "ledge@other", port: 0,
      keyPath: "", auth: "key", password: null, hostKey: null });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("another host");
    expect(state.servers[0]).toEqual(VPS);

    const pinned = await o.connectionUpdate({
      ...VPS,
      destination: "ledge@other",
      port: 0,
      keyPath: "",
      auth: "key",
      password: null,
      hostKey: "ssh-ed25519 AAAAother",
    });
    expect(pinned).toEqual({ ok: true, error: "" });
    expect(state.servers[0]).toMatchObject({ destination: "ledge@other", hostKey: "ssh-ed25519 AAAAother" });
  });

  test("the server being used cannot go while there is another to switch to", async () => {
    const { state, o } = withServers([VPS, PI], VPS.id);
    expect((await o.connectionRemove({ id: VPS.id })).error).toContain("Switch to another server");
    expect(state.servers).toHaveLength(2);
    expect(await o.connectionRemove({ id: PI.id })).toEqual({ ok: true, error: "" });
    expect(state.servers.map((s) => s.id)).toEqual([VPS.id]);
    expect(state.selected).toBe(VPS.id);
    expect((await o.connectionRemove({ id: PI.id })).error).toContain("no such connection");
  });

  // A Mac always has somewhere else to be — the server in its own process — so
  // it refuses this. A phone has none, which is exactly why the last one has to
  // be removable: it is the only way to forget a server that was typed wrong.
  test("removing the last server is how a phone forgets one", async () => {
    const { state, o } = withServers([VPS]);
    expect(await o.connectionRemove({ id: VPS.id })).toEqual({ ok: true, error: "" });
    expect(state.servers).toEqual([]);
    expect(state.selected).toBe("");
  });

  test("a fingerprint comes from the shell, which is the only end that can dial", async () => {
    const { probed, o } = withServers([VPS]);
    expect(await o.connectionProbe({ destination: "ledge@new", port: 0 })).toEqual({
      hostKey: "ssh-ed25519 AAAAnew",
      fingerprint: "SHA256:new+key",
      keyType: "ssh-ed25519",
      error: "",
    });
    // And the port travels, because the line it comes back with is the line
    // that gets pinned (shared/connections.ts knownHostsHost).
    await o.connectionProbe({ destination: "ledge@new", port: 2222 });
    expect(probed).toEqual(["ledge@new", "ledge@new:2222"]);
  });

  test("everything else is the server's", async () => {
    const o = overlay(async () => null, noServer({ noteList: async () => ({ notes: [] }) }));
    expect(await o.noteList({ root: "/notes" })).toEqual({ notes: [] });
    expect(o.noteWrite({ path: "/notes/a.md", text: "", baseMtimeMs: null })).rejects.toThrow("reached the wire");
  });
});
