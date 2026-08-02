// The page's half of the iOS bridge (ios.md §2). Everything here is `post` in
// and `deliver` out, which is the whole reason the module was written that
// way: the protocol between a webview and a Swift shell is testable in Bun,
// and only the three lines that touch WebKit are not.
import { describe, expect, test } from "bun:test";
import { CLIENT_METHODS, fromBase64, REQUEST_METHODS, toBase64, type RequestClient } from "../../shared/wire";
import { iosClientMethods, nativeOverlay, nativeShell, SHELL_CALLS, type ToShell } from "./nativeBridge";

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
    answer("@hello", { client: "device-1", destination });
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
    expect(await greeted("dan@mac.local")).toEqual({ client: "device-1", destination: "dan@mac.local" });
    expect(shell.destination()).toBe("dan@mac.local");
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

const booted: number[] = [];

function overlay(calls: (m: string, p: unknown) => Promise<unknown>, requests = noServer()): RequestClient {
  return nativeOverlay(
    requests,
    { call: (m, p) => calls(m, p), destination: () => "dan@mac.local" },
    "0.1.0-server",
    () => booted.push(1),
  );
}

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

  test("the connection list names the machine the shell reached", async () => {
    const status = await overlay(async () => null).connectionList({});
    expect(status.connections.map((c) => c.destination)).toEqual(["dan@mac.local"]);
    expect(status.active).toBe(status.connections[0]!.id);
    expect(status.error).toBe("");
    // Both are facts about how a phone connects, not placeholders: the host key
    // was pinned at pairing, and the client key has no path because it is in
    // the Secure Enclave (ios.md §4).
    expect(status.connections[0]).toMatchObject({ pinned: true, keyPath: "" });
    // The SERVER's build, not the client's: the chrome shows what it reached.
    expect(status.build).toBe("0.1.0-server");
  });

  test("the four verbs that would change it refuse in a sentence", async () => {
    const o = overlay(async () => null);
    expect((await o.connectionAdd({ name: "n", destination: "d", keyPath: "", hostKey: "" })).error).toContain("one server");
    expect((await o.connectionRemove({ id: "shell" })).error).toContain("one server");
    expect((await o.connectionProbe({ destination: "d" })).error).toContain("one server");
    expect((await o.connectionSelect({ id: "elsewhere" })).ok).toBe(false);
  });

  // The ladder gives up for good when a restarted server answers with a new
  // instance (shared/transport.ts), and choosing the connection again is what
  // rebuilds from boot. On a phone that is the page reloading, and the row is
  // the only recovery there is — so a refusal here would be an app that stays
  // dead until it is force-quit.
  test("choosing the one server again is a boot, and a wrong id is not", async () => {
    const o = overlay(async () => null);
    booted.length = 0;
    expect(await o.connectionSelect({ id: (await o.connectionList({})).connections[0]!.id })).toEqual({
      ok: true,
      error: "",
    });
    expect(booted.length).toBe(1);
    await o.connectionSelect({ id: "elsewhere" });
    expect(booted.length).toBe(1);
  });

  test("everything else is the server's", async () => {
    const o = overlay(async () => null, noServer({ noteList: async () => ({ notes: [] }) }));
    expect(await o.noteList({ root: "/notes" })).toEqual({ notes: [] });
    expect(o.noteWrite({ path: "/notes/a.md", text: "", baseMtimeMs: null })).rejects.toThrow("reached the wire");
  });
});
