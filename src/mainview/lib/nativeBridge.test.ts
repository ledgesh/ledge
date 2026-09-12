// The page's half of the iOS bridge (ios.md §2). `nativeShell` is pure: `post`
// is its only way out and `deliver` Swift's only way in, a shape chosen so the
// protocol between a webview and a Swift shell can be tested in Bun. These
// tests drive all of it with those two functions. `attachShell` is the only
// part that touches WebKit, and nothing here covers it.
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
  // Reply to a pending call by method name. `greeted` and `opened` below use
  // it to play out the dial handshake. A test that only cares about bytes can
  // then skip past that handshake.
  const answer = (m: string, r: unknown) => {
    // The last call with this name, not the first. A reconnect dials `@open`
    // again, and replying to the earlier id would settle nothing and hang the
    // test.
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
    // `@hello` answers four facts at once, all needed before a connection
    // exists: the client id keys the saved layout, the label names this phone
    // on the other clients' screens, the destination names the machine, and
    // the key line is what a new server has to be given (ios.md §4).
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
    // SHELL_CALLS lists the cases of the Swift switch
    // (ios/Sources/WebHost.swift). A name here that is missing there falls to
    // that switch's `default`, and the call comes back rejected with "the
    // Ledge shell has no <method>".
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
    // The server's hello can arrive before anything is reading. `dial()`
    // resolving and clientConnection attaching its reader are two statements
    // apart (shared/transport.ts), and fedDuplex holds the early bytes until
    // `onData` is set.
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
// id and the page hands it to the registry. The tests below check that the
// bridge passes an id through without interpreting it.
// Foregrounding, which is the one message on this channel that is about the
// app rather than about a socket or a key. ios.tsx probes the wire on it
// rather than reloading (ios.md §5), and the duration is Swift's measurement
// because no timer of the page's ran while the app was away.
describe("coming back to the foreground", () => {
  test("hands the subscriber how long the app was away", () => {
    const { shell } = recorder();
    const trips: number[] = [];
    shell.onResume((awayMs) => trips.push(awayMs));
    shell.deliver({ t: "resumed", away: 1_800 });
    shell.deliver({ t: "resumed", away: 612_000 });
    expect(trips).toEqual([1_800, 612_000]);
  });

  test("before anything subscribes, it is dropped rather than thrown", () => {
    // The window between the page loading and ios.tsx reaching its
    // subscription, which is behind the first dial and so behind a network.
    // A throw would land in `deliver`, which Swift calls from
    // evaluateJavaScript and cannot handle.
    const { shell } = recorder();
    expect(() => shell.deliver({ t: "resumed", away: 40 })).not.toThrow();
  });

  test("and it settles no pending native call", async () => {
    // A resume and a reply cross the same channel. This one carries no id, so
    // the case is that it is not mistaken for one.
    const { shell } = recorder();
    let settled = false;
    void shell.call("clipboard.read", {}).then(() => (settled = true));
    shell.deliver({ t: "resumed", away: 40 });
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});

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
    // The window between the page loading and ios.tsx registering the
    // dispatcher. There is no editor yet, so a tap in it means nothing. A
    // throw would land in `deliver`, which Swift calls from
    // evaluateJavaScript and cannot handle.
    const { shell } = recorder();
    expect(() => shell.deliver({ t: "verb", id: "format.bold" })).not.toThrow();
  });

  test("a verb is not a reply, and settles no pending call", async () => {
    // A verb and a reply cross the same channel. An id collision between the
    // two would settle a native call with a command name.
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

  // The run's face sends key names rather than command ids, and they land in
  // editor/inlineTerm.ts rather than the command registry. One channel carries
  // both vocabularies, so neither may arrive as the other.
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

// focusReporter is the filter in front of `@focus`. Focus events arrive in
// pairs and the editor keeps focus across most of them, so the shell is told
// only about transitions.
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
    // opening "none" would be a bridge call that changes nothing. Swift
    // compares the face it is sent against the one it holds and does nothing
    // when they match (ios/Sources/WebHost.swift).
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

  // A move with no blur in the middle. A run takes the keyboard from the prose
  // it runs under, and both surfaces sit in the same editor. A filter that only
  // knew "focused or not" would report nothing here, and the bar would keep
  // offering Bold to a program waiting for a password.
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

// Why `gen` exists. A reconnect dials while the previous socket's close is
// still crossing the bridge. Without the generation number, that close and its
// late frames would land on the connection that just replaced it.
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
 * A server that answers nothing. Reaching it is the failure under test.
 *
 * A real object over every method rather than a Proxy: `nativeOverlay` spreads
 * what it is given, and a Proxy's methods are not own properties. A fake that
 * vanished under the spread would fail for a reason the code does not have.
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
  /** Which door (remote.md §4). The password is not in the list: it goes to
   * the phone's keychain by its own call, which `withServers` records below. */
  auth: "key" | "password";
}

/**
 * The phone's stored server list, driven the way Swift drives it.
 * `servers.list`, `servers.save` and `servers.password` are all Swift persists
 * (ios/Sources/ShellConfig.swift, ServerPassword.swift). The rules for adding,
 * renaming and removing are in this overlay beside the Mac's in
 * bun/connectionManager.ts (ios.md §2), so this fake exercises all of them.
 */
function withServers(servers: StoredServer[], selected = servers[0]?.id ?? "") {
  // `passwords` stands in for the phone's keychain. No reply reads one back,
  // so a test sees only what was put there, which is all the page can see too
  // (remote.md §4).
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
    // Not even the shell. There is no menu bar on a phone to hand this to.
    expect(asked).toEqual([]);
  });

  test("a pasted image is read here and named there", async () => {
    const png = toBase64(new Uint8Array([137, 80, 78, 71]));
    const wrote: unknown[] = [];
    const o = overlay(async () => png, noServer({ assetWrite: async (p) => (wrote.push(p), { src: ".ledge-assets/1.png" }) }));
    expect(await o.assetPaste({ root: "/notes", notePath: "/notes/a.md" })).toEqual({ src: ".ledge-assets/1.png" });
    // The bytes cross and the name comes back. The client never names a file.
    expect(wrote).toEqual([{ root: "/notes", notePath: "/notes/a.md", dataB64: png }]);
    expect(fromBase64(png)).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  test("a paste event's picture is encoded here rather than read again", async () => {
    // WebKit already read the picture during the user's Paste (ios.md §11),
    // so the bytes the event carried go to `image.encode` and the pasteboard
    // is not read a second time.
    const carried = toBase64(new Uint8Array([137, 80, 78, 71]));
    const jpeg = toBase64(new Uint8Array([0xff, 0xd8, 0xff]));
    const asked: unknown[] = [];
    const wrote: unknown[] = [];
    const o = overlay(
      async (m, p) => (asked.push([m, p]), jpeg),
      noServer({ assetWrite: async (p) => (wrote.push(p), { src: ".ledge-assets/1.jpg" }) }),
    );
    expect(await o.assetPaste({ root: "/notes", notePath: "/notes/a.md", dataB64: carried })).toEqual({
      src: ".ledge-assets/1.jpg",
    });
    expect(asked).toEqual([["image.encode", { dataB64: carried }]]);
    expect(wrote).toEqual([{ root: "/notes", notePath: "/notes/a.md", dataB64: jpeg }]);
  });

  test("no image on the pasteboard costs the server nothing", async () => {
    // noServer() throws on assetWrite, so the test passing is the assertion.
    expect(await overlay(async () => "").assetPaste({ root: "/notes", notePath: "/notes/a.md" })).toEqual({ src: null });
  });

  test("Insert Image… takes the picture the shell's pickers answered, and the server names it", async () => {
    const png = toBase64(new Uint8Array([137, 80, 78, 71]));
    const asked: unknown[] = [];
    const wrote: unknown[] = [];
    const o = overlay(
      async (m, p) => (asked.push([m, p]), png),
      noServer({ assetWrite: async (p) => (wrote.push(p), { src: ".ledge-assets/1.png" }) }),
    );
    expect(await o.assetPick({ root: "/notes", notePath: "/notes/a.md" })).toEqual({ src: ".ledge-assets/1.png" });
    expect(asked).toEqual([["image.pick", {}]]);
    expect(wrote).toEqual([{ root: "/notes", notePath: "/notes/a.md", dataB64: png }]);
  });

  test("a cancelled pick costs the server nothing", async () => {
    // noServer() throws on assetWrite, so the test passing is the assertion.
    expect(await overlay(async () => "").assetPick({ root: "/notes", notePath: "/notes/a.md" })).toEqual({ src: null });
  });

  test("the connection list is this phone's own, and the selection is what is served", async () => {
    const { o } = withServers([VPS, PI], PI.id);
    const status = await o.connectionList({});
    expect(status.connections.map((c) => c.name)).toEqual(["VPS", "Pi"]);
    expect(status.active).toBe(PI.id);
    expect(status.wanted).toBe(PI.id);
    // No boot-time fallback to report. A phone with no reachable server never
    // renders the connection chrome: it shows the refusal page in ios.tsx
    // instead.
    expect(status.error).toBe("");
    // Both fields are facts rather than placeholders. The host key was pinned
    // when the server was added, and the client key has no path because it is
    // in the Secure Enclave (ios.md §4).
    expect(status.connections[0]).toMatchObject({ pinned: true, keyPath: "" });
    // The server's build rather than the client's. The chrome shows what it
    // reached.
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

  // The same predicate the Mac applies (shared/connections.ts
  // validateConnection). The field becomes ssh's argv, and a destination
  // starting with "-" is an option.
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
    // Selecting the one already selected still reports ok, so the caller goes
    // on to reload and rebuild the session (lib/connections.ts). That is how a
    // phone reconnects once its reconnect ladder has given up, and on a phone
    // it is the only recovery. A refusal here would leave the app disconnected
    // until it was force-quit.
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

  // A host key belongs to the host, not the account, so changing the user half
  // of the destination is not a move and needs no new pin.
  test("changing only the account keeps the pin", async () => {
    const { state, o } = withServers([VPS]);
    const res = await o.connectionUpdate({ ...VPS, destination: "dev@vps", port: 0,
      keyPath: "", auth: "key", password: null, hostKey: null });
    expect(res).toEqual({ ok: true, error: "" });
    expect(state.servers[0]).toMatchObject({ destination: "dev@vps", hostKey: VPS.hostKey });
  });

  // The password door (remote.md §4). The rules live in the overlay beside the
  // Mac's in bun/connectionStore.ts, so "may this be stored" has one answer
  // rather than one per client.
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
    // The record names the door and nothing more. The whole list goes back to
    // Swift on every rename, so a credential in it would cross the bridge
    // every time.
    expect(JSON.stringify(state.servers)).not.toContain("hunter2");
    expect(state.servers.find((server) => server.id === id)).toMatchObject({ auth: "password" });
  });

  // Both clients check with validatePassword (shared/connections.ts), so both
  // refuse the same passwords. A Mac delivers one through ssh's askpass
  // helper, which reads a single line. A phone hands it to NIOSSH instead
  // (ios/Sources/SSHTransport.swift PasswordAuth).
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

  // The pin is a key with no hostname, because a phone has no known_hosts file
  // for one to index. Nothing about it says which machine it came from, so
  // carrying it to another address would fail every later dial with a changed
  // host key.
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

  // A Mac refuses this, because it always has somewhere else to be: the server
  // in its own process. A phone has none, so its last server can go. That is
  // the only way a phone forgets a server that was typed wrong.
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
    // The port travels with the probe, because the line that comes back is the
    // line that gets pinned (shared/connections.ts knownHostsHost).
    await o.connectionProbe({ destination: "ledge@new", port: 2222 });
    expect(probed).toEqual(["ledge@new", "ledge@new:2222"]);
  });

  test("everything else is the server's", async () => {
    const o = overlay(async () => null, noServer({ noteList: async () => ({ notes: [] }) }));
    expect(await o.noteList({ root: "/notes" })).toEqual({ notes: [] });
    expect(o.noteWrite({ path: "/notes/a.md", text: "", baseMtimeMs: null })).rejects.toThrow("reached the wire");
  });
});
