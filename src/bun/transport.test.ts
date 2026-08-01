// The two ends of a connection, run against each other over a pipe made of
// promises. What this covers that wire.test.ts cannot is the conversation:
// who speaks first, what happens to a request whose server has not finished
// booting, and how a server answers a client that is not following the rules.
//
// No processes here. spawnDuplex and stdioDuplex are three lines of Bun API
// each and are exercised for real in serve.fs.test.ts, which is the only place
// a pipe can actually break.
import { describe, expect, test } from "bun:test";
import {
  CONTROL_FRAME,
  encodeBinary,
  encodeControl,
  FrameDecoder,
  hello,
  parseControl,
  PROTOCOL_VERSION,
  PUSH_MESSAGES,
  type WireMessage,
} from "../shared/wire";
import { clientConnection, reconnectingClient, serverConnection, type Duplex, type ServerConnection } from "./transport";
import { createOpLog } from "./opLog";
import type { RequestHandlers, ServerPush } from "./server";

// --- a pipe -------------------------------------------------------------------

interface Endpoint extends Duplex {
  deliver(chunk: Uint8Array): void;
  hangup(): void;
}

// Buffers until someone is listening, exactly as the real duplexes do: a
// server writes its hello the moment it is built, which is before the far end
// of a test's pipe exists.
function endpoint(): Endpoint {
  let onData: ((chunk: Uint8Array) => void) | undefined;
  let onClose: (() => void) | undefined;
  const waiting: Uint8Array[] = [];
  let hungUp = false;
  return {
    write() {
      throw new Error("this endpoint was not wired to a peer");
    },
    close() {},
    get onData() {
      return onData;
    },
    set onData(fn) {
      onData = fn;
      for (const chunk of waiting.splice(0)) fn?.(chunk);
    },
    get onClose() {
      return onClose;
    },
    set onClose(fn) {
      onClose = fn;
      if (hungUp) fn?.();
    },
    deliver(chunk) {
      if (onData) onData(chunk);
      else waiting.push(chunk);
    },
    hangup() {
      if (hungUp) return;
      hungUp = true;
      onClose?.();
    },
  };
}

function pipePair(): { a: Endpoint; b: Endpoint } {
  const a = endpoint();
  const b = endpoint();
  // Asynchronous delivery on purpose: a real pipe never calls back into the
  // writer's own stack, and a synchronous one would hide re-entrancy bugs.
  a.write = (bytes) => queueMicrotask(() => b.deliver(bytes));
  b.write = (bytes) => queueMicrotask(() => a.deliver(bytes));
  a.close = () => {
    a.hangup();
    queueMicrotask(() => b.hangup());
  };
  b.close = () => {
    b.hangup();
    queueMicrotask(() => a.hangup());
  };
  return { a, b };
}

/** Let every queued microtask and the promises behind them run out. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Refusals are logged server-side, and a test that provokes six of them
 * should not bury its own output in them. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const was = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = was;
  }
}

// --- stubs --------------------------------------------------------------------

// The dispatcher looks a method up by name in whatever map it is handed, so a
// full 59-handler map would prove nothing this one does not. The cast is
// deliberate: RequestHandlers is exhaustive by design (server.ts), and
// stubbing all of it here would be a maintenance tax with no test inside it.
function handlers(over: Record<string, (p: never) => unknown> = {}): RequestHandlers {
  return {
    vaultState: () => ({ state: "locked" }),
    noteRead: ({ path }: { path: string }) => {
      if (path.includes("..")) throw new Error(`outside the workspace roots: ${path}`);
      return { note: { text: `# ${path}`, mtimeMs: 1 } };
    },
    ...over,
  } as unknown as RequestHandlers;
}

function recordingPush(): { push: ServerPush; seen: Array<[string, unknown]> } {
  const seen: Array<[string, unknown]> = [];
  const push = Object.fromEntries(
    PUSH_MESSAGES.map((m) => [m, (p: unknown) => seen.push([m, p])]),
  ) as unknown as ServerPush;
  return { push, seen };
}

/** A client that speaks frames by hand, for the things a well-behaved one
 * cannot do. */
function rawClient(end: Duplex) {
  const decoder = new FrameDecoder();
  const heard: WireMessage[] = [];
  let closed = false;
  end.onData = (chunk) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type === CONTROL_FRAME) heard.push(parseControl(frame.text));
    }
  };
  end.onClose = () => {
    closed = true;
  };
  return {
    heard,
    isClosed: () => closed,
    send: (msg: WireMessage) => end.write(encodeControl(msg)),
    raw: (bytes: Uint8Array) => end.write(bytes),
    last: () => heard[heard.length - 1],
  };
}

// --- a client and a server ----------------------------------------------------

describe("a client and a server over one connection", () => {
  function connect(over?: Record<string, (p: never) => unknown>) {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0" });
    server.serve(handlers(over));
    const { push, seen } = recordingPush();
    const client = clientConnection(pipe.b, { push, build: "0.1.0" });
    return { server, client, seen, pipe };
  }

  test("a request reaches the handler and its answer comes back", async () => {
    const { client } = connect();
    expect(await client.requests.noteRead({ path: "/notes/a.md" })).toEqual({
      note: { text: "# /notes/a.md", mtimeMs: 1 },
    });
  });

  test("the handshake identifies the peer's build", async () => {
    const pipe = pipePair();
    serverConnection(pipe.a, { build: "9.9.9" }).serve(handlers());
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0" });
    expect((await client.ready).build).toBe("9.9.9");
  });

  // Identity comes from the connection, not from each call (remote.md §5), so
  // the server can key a saved layout by who is asking without the view ever
  // holding an id. Read after the handshake, which is the only time any
  // handler runs.
  test("the server learns which client connected", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0" });
    server.serve(handlers());
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0", client: "mac-1" });
    await client.ready;
    expect(server.client()).toBe("mac-1");
  });

  test("a client that names nobody is still a client", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0" });
    server.serve(handlers());
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0" });
    await client.ready;
    expect(server.client()).toBe("");
    expect(await client.requests.vaultState({})).toEqual({ state: "locked" });
  });

  // The whole reason a guard stays server-side (remote.md §2): it refuses over
  // the wire exactly as it refuses in-process, and its own words are what the
  // caller sees.
  test("a handler that throws rejects the caller with its refusal", async () => {
    const { client } = connect();
    await expect(client.requests.noteRead({ path: "../../.ssh/id_rsa" })).rejects.toThrow(
      "outside the workspace roots: ../../.ssh/id_rsa",
    );
  });

  test("answers are correlated, not ordered", async () => {
    let releaseSlow: (v: unknown) => void = () => {};
    const slow = new Promise((resolve) => (releaseSlow = resolve));
    const { client } = connect({
      noteSearch: async () => {
        await slow;
        return { hits: [], lockedSkipped: 7 };
      },
    });
    const first = client.requests.noteSearch({ root: "/r", query: "q" });
    const second = await client.requests.vaultState({});
    expect(second).toEqual({ state: "locked" });
    releaseSlow(null);
    expect(await first).toEqual({ hits: [], lockedSkipped: 7 });
  });

  test("a push reaches the client's message handlers", async () => {
    const { server, seen } = connect();
    server.push.notesChanged({ root: "/notes" });
    server.push.vaultChanged({ state: "unlocked" });
    await settle();
    expect(seen).toEqual([
      ["notesChanged", { root: "/notes" }],
      ["vaultChanged", { state: "unlocked" }],
    ]);
  });

  test("a request in flight when the connection drops rejects rather than hangs", async () => {
    const { client, pipe } = connect({ noteSearch: () => new Promise(() => {}) });
    const pending = client.requests.noteSearch({ root: "/r", query: "q" });
    await settle();
    pipe.a.close();
    await expect(pending).rejects.toThrow(/connection to the server closed/);
  });

  test("closing settles both ends", async () => {
    const { server, client } = connect();
    await client.ready;
    client.close();
    await Promise.all([server.closed, client.closed]);
  });
});

// --- a server facing a client that is not following the rules -----------------

describe("a server facing a misbehaving client", () => {
  function listen(handlerMap: RequestHandlers | null = handlers()) {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0" });
    if (handlerMap) server.serve(handlerMap);
    return { server, client: rawClient(pipe.b) };
  }

  test("the server greets first, unprompted", async () => {
    const { client } = listen();
    await settle();
    expect(client.heard[0]).toMatchObject({ t: "hello", role: "server", protocol: PROTOCOL_VERSION });
  });

  test("a request before the hello is refused and the connection ends", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send({ t: "req", id: 1, m: "vaultState", p: {} });
      await settle();
      expect(client.last()).toMatchObject({ t: "bye", why: expect.stringContaining("expected a hello first") });
      expect(client.isClosed()).toBe(true);
    });
  });

  test("a client on another protocol version is refused with both named", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send({ ...hello("client", "0.1.0"), protocol: 99 });
      await settle();
      const bye = client.last();
      expect(bye?.t).toBe("bye");
      expect(bye?.t === "bye" && bye.why).toContain("99");
      expect(bye?.t === "bye" && bye.why).toContain(String(PROTOCOL_VERSION));
      expect(client.isClosed()).toBe(true);
    });
  });

  test("a client sending a server's message is refused", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send(hello("client", "0.1.0"));
      client.send({ t: "push", m: "notesChanged", p: { root: "/" } });
      await settle();
      expect(client.last()).toMatchObject({ t: "bye", why: "a client may not send push" });
    });
  });

  test("an unknown method is one failed request, not a dropped connection", async () => {
    const { client } = listen();
    client.send(hello("client", "0.1.0"));
    client.send({ t: "req", id: 1, m: "rmRf", p: {} });
    client.send({ t: "req", id: 2, m: "vaultState", p: {} });
    await settle();
    expect(client.heard).toContainEqual({ t: "err", id: 1, e: "unknown method: rmRf" });
    expect(client.heard).toContainEqual({ t: "res", id: 2, r: { state: "locked" } });
    expect(client.isClosed()).toBe(false);
  });

  // The handler map is an object literal, so everything reachable through its
  // prototype is the client trying its luck rather than a method.
  test.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "%s is not a method",
    async (method) => {
      const { client } = listen();
      client.send(hello("client", "0.1.0"));
      client.send({ t: "req", id: 1, m: method, p: {} });
      await settle();
      expect(client.last()).toEqual({ t: "err", id: 1, e: `unknown method: ${method}` });
    },
  );

  test("an unreadable frame ends the connection", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send(hello("client", "0.1.0"));
      client.raw(new Uint8Array([0, 0, 0, 1, 77, 0]));
      await settle();
      expect(client.isClosed()).toBe(true);
    });
  });

  // A binary frame is claimed by the control frame right behind it (wire.ts).
  // These are the three ways a peer can break that rule, and all three are
  // fatal for the same reason a bad length is: there is no resynchronizing a
  // stream whose framing is in doubt.
  test("bytes that no control frame claims end the connection", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send(hello("client", "0.1.0"));
      client.raw(encodeBinary(1, new Uint8Array([1, 2, 3])));
      client.send({ t: "req", id: 1, m: "vaultState", p: {} });
      await settle();
      expect(client.last()).toMatchObject({ t: "bye", why: expect.stringContaining("no control frame claimed") });
    });
  });

  test("two binary frames with nothing between them end the connection", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send(hello("client", "0.1.0"));
      client.raw(encodeBinary(1, new Uint8Array([1])));
      client.raw(encodeBinary(2, new Uint8Array([2])));
      await settle();
      expect(client.last()).toMatchObject({ t: "bye", why: expect.stringContaining("two binary frames") });
    });
  });

  test("claiming bytes that never arrived ends the connection", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send(hello("client", "0.1.0"));
      client.send({ t: "req", id: 1, m: "assetWrite", p: { root: "/w", dataB64: "" }, bin: 7 });
      await settle();
      expect(client.last()).toMatchObject({ t: "bye", why: expect.stringContaining("did not arrive") });
    });
  });

  // A method with no binary field has nowhere to put bytes, so accepting them
  // would mean silently dropping what a peer sent.
  test("bytes attached to a method that carries none end the connection", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send(hello("client", "0.1.0"));
      client.raw(encodeBinary(3, new Uint8Array([1])));
      client.send({ t: "req", id: 1, m: "vaultState", p: {}, bin: 3 });
      await settle();
      expect(client.last()).toMatchObject({ t: "bye", why: expect.stringContaining("carries none") });
    });
  });

  // A server sends its hello before createServer has finished loading the
  // vault and syncing the docs, so a brisk client can genuinely get here.
  test("a request that beats the handlers waits for them instead of failing", async () => {
    const { server, client } = listen(null);
    client.send(hello("client", "0.1.0"));
    client.send({ t: "req", id: 1, m: "vaultState", p: {} });
    await settle();
    expect(client.heard.some((m) => m.t === "res" || m.t === "err")).toBe(false);

    server.serve(handlers());
    await settle();
    expect(client.last()).toEqual({ t: "res", id: 1, r: { state: "locked" } });
  });
});

// --- a client facing a server that is not there -------------------------------

describe("a client facing a server that will not talk", () => {
  test("a server that hangs up without a hello fails the connection", async () => {
    const pipe = pipePair();
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0" });
    pipe.a.close();
    await expect(client.ready).rejects.toThrow(/connection to the server closed/);
  });

  test("a refused handshake reaches the client as the server's own words", async () => {
    const pipe = pipePair();
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0" });
    pipe.a.write(encodeControl({ t: "bye", why: "protocol version 1 on the client, 2 here" }));
    await expect(client.ready).rejects.toThrow("protocol version 1 on the client, 2 here");
  });

  test("a server on another schema is refused before any request is sent", async () => {
    const pipe = pipePair();
    const seen: Uint8Array[] = [];
    pipe.a.onData = (chunk) => seen.push(chunk);
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0" });
    pipe.a.write(encodeControl({ ...hello("server", "0.9.0"), schema: "deadbeef" }));
    await expect(client.ready).rejects.toThrow(/deadbeef/);
    await expect(client.requests.vaultState({})).rejects.toThrow(/deadbeef/);
    // The client's own hello and nothing after it: a request never went out
    // over a connection whose protocol was already in doubt.
    expect(seen.length).toBe(1);
  });
});

// --- what phase 4 added -------------------------------------------------------

describe("bytes ride binary frames rather than base64 (remote.md §3)", () => {
  // The saving is on the WIRE only: the schema still says base64 and the view
  // still receives it, because Electrobun's bridge is JSON either way. So the
  // assertion is in two halves — the payload arrives intact, and the bytes did
  // not travel inflated.
  test("a pasted image's bytes cross as bytes and arrive as the same base64", async () => {
    const pipe = pipePair();
    const seen: unknown[] = [];
    const server = serverConnection(pipe.a, { build: "0.1.0" });
    server.serve(
      handlers({
        assetWrite: (p: never) => {
          seen.push(p);
          return { src: ".ledge-assets/pasted-2026-08-01.png" };
        },
      }),
    );
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0" });
    // A PNG header plus a byte that is not valid UTF-8 on its own, which is
    // the whole reason these payloads are base64 in the schema.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const dataB64 = Buffer.from(bytes).toString("base64");
    expect(await client.requests.assetWrite({ root: "/w", notePath: null, dataB64 })).toEqual({
      src: ".ledge-assets/pasted-2026-08-01.png",
    });
    expect(seen).toEqual([{ root: "/w", notePath: null, dataB64 }]);
  });

  test("terminal output leaves as a binary frame, and its base64 is rebuilt on arrival", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", coalesce: { ms: 0 } });
    server.serve(handlers());
    const { push, seen } = recordingPush();
    const client = clientConnection(pipe.b, { push, build: "0.1.0" });
    await client.ready;
    // Bytes that are not valid UTF-8: a payload that survived the trip as
    // bytes rather than as text is the assertion.
    const bytes = new Uint8Array(3000).fill(0xab);
    server.push.terminalOutput({ sessionId: "s1", dataB64: Buffer.from(bytes).toString("base64") });
    await settle();
    expect(seen).toEqual([["terminalOutput", { sessionId: "s1", dataB64: Buffer.from(bytes).toString("base64") }]]);
  });

  test("the bytes on the wire are the payload's size, not a third more", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", coalesce: { ms: 0 } });
    server.serve(handlers());
    let bytesOut = 0;
    const decoder = new FrameDecoder();
    let sawBinary = false;
    pipe.b.onData = (chunk) => {
      bytesOut += chunk.length;
      for (const frame of decoder.push(chunk)) if (frame.type !== CONTROL_FRAME) sawBinary = true;
    };
    await settle();
    const before = bytesOut;
    const payload = new Uint8Array(30_000).fill(7);
    server.push.terminalOutput({ sessionId: "s1", dataB64: Buffer.from(payload).toString("base64") });
    await settle();
    expect(sawBinary).toBe(true);
    // Base64 would have cost 40_000. The slack is the two frame headers and
    // the JSON around them.
    expect(bytesOut - before).toBeLessThan(payload.length + 200);
  });
});

describe("terminal output is coalesced (remote.md §3)", () => {
  // Reassembles what the wire took apart: terminal output leaves as a binary
  // frame followed by a control frame with the field blanked, so a tap that
  // only read control frames would see every payload as empty.
  function tap(pipe: { a: Endpoint; b: Endpoint }) {
    const decoder = new FrameDecoder();
    const control: WireMessage[] = [];
    let held: Uint8Array | null = null;
    pipe.b.onData = (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type !== CONTROL_FRAME) {
          held = frame.bytes;
          continue;
        }
        const msg = parseControl(frame.text);
        if (msg.t === "push" && msg.bin !== undefined && held) {
          (msg.p as { dataB64: string }).dataB64 = Buffer.from(held).toString("base64");
          held = null;
        }
        control.push(msg);
      }
    };
    return control;
  }

  const outputs = (msgs: WireMessage[]) => msgs.filter((m) => m.t === "push" && m.m === "terminalOutput");

  // Nagle's shape, not a fixed delay: an echoed keystroke must not wait, so
  // the first chunk after a quiet moment goes out at once and only a shell
  // that is producing CONTINUOUSLY is batched.
  test("the first chunk after a quiet moment is not held", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", coalesce: { ms: 40 } });
    const control = tap(pipe);
    server.push.terminalOutput({ sessionId: "s", dataB64: Buffer.from("a").toString("base64") });
    await settle();
    expect(outputs(control).length).toBe(1);
  });

  test("chunks behind it are batched into one frame, in order", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", coalesce: { ms: 30 } });
    const control = tap(pipe);
    const say = (t: string) => server.push.terminalOutput({ sessionId: "s", dataB64: Buffer.from(t).toString("base64") });
    say("one");
    say("two");
    say("three");
    await new Promise((r) => setTimeout(r, 60));
    const sent = outputs(control);
    // The first went straight out; the two behind it arrived as one.
    expect(sent.length).toBe(2);
    const joined = sent.map((m) => Buffer.from((m as { p: { dataB64: string } }).p.dataB64, "base64").toString()).join("");
    expect(joined).toBe("onetwothree");
  });

  test("two sessions are two streams", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", coalesce: { ms: 30 } });
    const control = tap(pipe);
    server.push.terminalOutput({ sessionId: "a", dataB64: Buffer.from("x").toString("base64") });
    await new Promise((r) => setTimeout(r, 40));
    server.push.terminalOutput({ sessionId: "a", dataB64: Buffer.from("1").toString("base64") });
    server.push.terminalOutput({ sessionId: "b", dataB64: Buffer.from("2").toString("base64") });
    server.push.terminalOutput({ sessionId: "a", dataB64: Buffer.from("3").toString("base64") });
    await new Promise((r) => setTimeout(r, 60));
    const byId = new Map<string, string>();
    for (const m of outputs(control)) {
      const p = (m as { p: { sessionId: string; dataB64: string } }).p;
      byId.set(p.sessionId, (byId.get(p.sessionId) ?? "") + Buffer.from(p.dataB64, "base64").toString());
    }
    expect(byId.get("a")).toBe("x13");
    expect(byId.get("b")).toBe("2");
  });

  // The ordering rule, and the reason it is not optional: terminalAttach's
  // answer IS the scrollback up to that instant. Output held back from before
  // it would be painted on top of a snapshot that already contains it.
  test("held output is flushed before anything else is sent", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", coalesce: { ms: 200 } });
    server.serve(handlers({ terminalAttach: () => ({ dataB64: "", host: "local" }) }));
    const control = tap(pipe);
    const say = (t: string) => server.push.terminalOutput({ sessionId: "s", dataB64: Buffer.from(t).toString("base64") });
    say("first");
    say("held");
    server.push.terminalExit({ sessionId: "s" });
    await settle();
    const order = control.filter((m) => m.t === "push").map((m) => (m as { m: string }).m);
    expect(order).toEqual(["terminalOutput", "terminalOutput", "terminalExit"]);
  });
});

describe("a replayed request applies once (remote.md §7)", () => {
  // The op log belongs to the SERVER and is handed to each connection, because
  // the whole point is that it survives the connection that filled it.
  function twoConnections(handlerMap: RequestHandlers) {
    const ops = createOpLog();
    const open = () => {
      const pipe = pipePair();
      const server = serverConnection(pipe.a, { build: "0.1.0", ops, instance: "one-server" });
      server.serve(handlerMap);
      const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0", client: "mac-1" });
      return { server, client, pipe };
    };
    return { open };
  }

  test("the same op on a second connection is answered from the record, not run again", async () => {
    let writes = 0;
    const { open } = twoConnections(handlers({ noteWrite: () => ({ mtimeMs: ++writes, divergedTo: null }) }));
    const first = open();
    expect(await first.client.call("noteWrite", { path: "/a.md" }, "n1:1")).toEqual({ mtimeMs: 1, divergedTo: null });
    first.client.close();

    const second = open();
    expect(await second.client.call("noteWrite", { path: "/a.md" }, "n1:1")).toEqual({ mtimeMs: 1, divergedTo: null });
    expect(writes).toBe(1);
  });

  test("a request with no op is run every time, because a read is its own answer", async () => {
    let reads = 0;
    const { open } = twoConnections(handlers({ noteList: () => ({ notes: [], n: ++reads }) }));
    const c = open();
    await c.client.call("noteList", { root: "/w" });
    await c.client.call("noteList", { root: "/w" });
    expect(reads).toBe(2);
  });

  // Different clients count from 1 independently, so the window has to be
  // scoped by who is asking or two apps on one machine would answer each
  // other's writes.
  test("two clients' op ids do not collide", async () => {
    let writes = 0;
    const ops = createOpLog();
    const handlerMap = handlers({ noteWrite: () => ({ mtimeMs: ++writes, divergedTo: null }) });
    const open = (who: string) => {
      const pipe = pipePair();
      serverConnection(pipe.a, { build: "0.1.0", ops }).serve(handlerMap);
      return clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0", client: who });
    };
    await open("mac").call("noteWrite", { path: "/a.md" }, "n:1");
    await open("phone").call("noteWrite", { path: "/a.md" }, "n:1");
    expect(writes).toBe(2);
  });
});

describe("a client that reconnects", () => {
  /** A server behind a dial() that can be cut and rebuilt, which is what a
   * dropped ssh looks like from this side. */
  function reconnectable(handlerMap: RequestHandlers, opts: { instance?: () => string } = {}) {
    const ops = createOpLog();
    let current: { server: ServerConnection; pipe: ReturnType<typeof pipePair> } | null = null;
    let dials = 0;
    const dial = (): Duplex => {
      dials += 1;
      const pipe = pipePair();
      const server = serverConnection(pipe.a, {
        build: "0.1.0",
        ops,
        instance: opts.instance ? opts.instance() : "one-server",
      });
      server.serve(handlerMap);
      current = { server, pipe };
      return pipe.b;
    };
    return { dial, cut: () => current?.pipe.a.close(), dials: () => dials };
  }

  const instant = { delaysMs: [0, 0, 0], sleep: () => Promise.resolve() };

  test("a request in flight when the wire drops is finished by the next connection", async () => {
    let writes = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    const wire = reconnectable(
      handlers({
        noteWrite: async () => {
          if (first) {
            first = false;
            await held; // the answer this connection never gets to send
          }
          return { mtimeMs: ++writes, divergedTo: null };
        },
      }),
    );
    const client = await reconnectingClient({ dial: wire.dial, push: recordingPush().push, build: "0.1.0", ...instant });
    const pending = client.requests.noteWrite({ path: "/a.md", text: "x", baseMtimeMs: null });
    await settle();
    wire.cut();
    release();
    // The first connection ran it; the replay is answered from the record, so
    // the caller gets an answer and the file was written once.
    expect(await pending).toEqual({ mtimeMs: 1, divergedTo: null });
    expect(writes).toBe(1);
    expect(wire.dials()).toBe(2);
  });

  test("a request made mid-reconnect waits instead of failing", async () => {
    const wire = reconnectable(handlers());
    const client = await reconnectingClient({ dial: wire.dial, push: recordingPush().push, build: "0.1.0", ...instant });
    wire.cut();
    // No settle in between: this is issued while the ladder is still climbing.
    expect(await client.requests.vaultState({})).toEqual({ state: "locked" });
  });

  test("the indicator is told, in order", async () => {
    const states: string[] = [];
    const wire = reconnectable(handlers());
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s) => states.push(s),
      ...instant,
    });
    wire.cut();
    await client.requests.vaultState({});
    expect(states).toEqual(["reconnecting", "live"]);
  });

  // A handler saying no is an ANSWER, and answers are final. Only a transport
  // failure is worth replaying, or every refusal would be retried against a
  // server that already refused it.
  test("a refusal is reported, not replayed", async () => {
    const wire = reconnectable(handlers());
    const client = await reconnectingClient({ dial: wire.dial, push: recordingPush().push, build: "0.1.0", ...instant });
    await expect(client.requests.noteRead({ path: "../../.ssh/id_rsa" })).rejects.toThrow("outside the workspace roots");
    expect(wire.dials()).toBe(1);
  });

  // The one case where replaying would apply a write twice: a fresh server has
  // an empty op log, so it cannot tell a replay from a first attempt.
  test("a DIFFERENT server answering fails what was in flight rather than replaying it", async () => {
    let n = 0;
    const wire = reconnectable(handlers({ noteWrite: () => new Promise(() => {}) }), { instance: () => `run-${++n}` });
    const states: string[] = [];
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s, d) => states.push(`${s}:${d}`),
      ...instant,
    });
    const pending = client.requests.noteWrite({ path: "/a.md", text: "x", baseMtimeMs: null });
    await settle();
    wire.cut();
    await expect(pending).rejects.toThrow("the server restarted");
    expect(states.at(-1)).toContain("lost:");
  });

  test("a ladder that runs out gives up, says the last reason, and stops pretending", async () => {
    let alive = true;
    let cut!: () => void;
    const dial = (): Duplex => {
      if (!alive) throw new Error("host is down");
      const pipe = pipePair();
      serverConnection(pipe.a, { build: "0.1.0", instance: "one-server" }).serve(
        handlers({ noteWrite: () => new Promise(() => {}) }),
      );
      cut = () => pipe.a.close();
      return pipe.b;
    };
    const states: string[] = [];
    const client = await reconnectingClient({
      dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s, d) => states.push(`${s}:${d}`),
      ...instant,
    });
    const pending = client.requests.noteWrite({ path: "/a.md", text: "x", baseMtimeMs: null });
    await settle();
    alive = false;
    cut();
    // What was in flight is failed with the reason, rather than waiting on a
    // wire that is not coming back.
    await expect(pending).rejects.toThrow("host is down");
    expect(states.at(-1)).toContain("lost:");
    // And nothing new is accepted: an app that keeps taking requests for a
    // server it cannot reach looks like it is working.
    await expect(client.requests.vaultState({})).rejects.toThrow("There is no connection to the server.");
  });
});
