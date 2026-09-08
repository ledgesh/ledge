// The two ends of a connection, run against each other over an in-memory
// pipe. What this covers that wire.test.ts cannot is the conversation: who
// speaks first, what happens to a request whose server has not finished
// booting, and how a server answers a client that is not following the rules.
//
// A server is a handler map, a coalescer, and an op log a replay is deduped
// against, so every test here has one. The client's half lives in
// shared/transport.ts, so the tests that need only a client (the handshakes it
// refuses, and fedDuplex) are in shared/transport.test.ts, which imports
// nothing from this directory.
//
// No processes here either. spawnDuplex and stdioDuplex are three lines of Bun
// API each, and serve.fs.test.ts drives them against a real child process. That
// is the only place a pipe can actually break.
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
  type RequestHandlers,
  type ServerPush,
  type WireMessage,
} from "../shared/wire";
import { clientConnection, reconnectingClient, type Duplex } from "../shared/transport";
import { serverConnection, socketWriter, type ServerConnection } from "./transport";
import { createOpLog } from "./opLog";

// --- a pipe -------------------------------------------------------------------

interface Endpoint extends Duplex {
  deliver(chunk: Uint8Array): void;
  hangup(): void;
}

// Buffers until someone is listening, as the real duplexes do. A server
// writes its hello the moment it is built, before the far end of a test's pipe
// exists.
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
  // Delivery is asynchronous, as a real pipe's is: it never calls back into
  // the writer's own stack. Synchronous delivery would hide re-entrancy bugs.
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

/** A repeating timer a test drives by hand, standing in for the one the
 * heartbeat runs at either end. Forty seconds of silence costs one function
 * call, so no test below waits on a clock. */
function ticker() {
  const ticks = new Set<() => void>();
  return {
    repeat: (_ms: number, tick: () => void) => {
      ticks.add(tick);
      return () => void ticks.delete(tick);
    },
    beat(times = 1) {
      for (let i = 0; i < times; i++) for (const tick of [...ticks]) tick();
    },
    running: () => ticks.size,
  };
}

/** Silences console.error while `fn` runs. Some refusals are logged
 * server-side (bun/transport.ts), and a test that provokes several of them
 * would bury its own output. */
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

// Two handlers rather than the full 59-handler map. The dispatcher looks a
// method up by name in whatever map it is handed (bun/transport.ts dispatch),
// so the rest would prove nothing. The cast is here because RequestHandlers
// covers every method in the schema (wire.ts), and stubbing all 59 would be
// maintenance for no test.
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
  // the server can key a saved layout by who is asking and the view never
  // holds an id. No request is dispatched before the handshake, so a handler
  // reading `client()` always has the answer (bun/transport.ts).
  test("the server learns which client connected", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0" });
    server.serve(handlers());
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0", client: "mac-1" });
    await client.ready;
    expect(server.client()).toBe("mac-1");
  });

  // The vault scopes an unlock to a device, and several windows on one Mac are
  // one device (locking.md §3a, wire.ts `Hello.device`).
  test("the server learns which device the client runs on", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0" });
    server.serve(handlers());
    const client = clientConnection(pipe.b, {
      push: recordingPush().push,
      build: "0.1.0",
      client: "window-2",
      device: "mac-1",
    });
    await client.ready;
    expect(server.client()).toBe("window-2");
    expect(server.device()).toBe("mac-1");
  });

  test("a client that names no device is its own device", async () => {
    // What a phone sends (one window) and what a peer predating the field
    // sends. The fallback scopes an unlock more narrowly than the sender
    // meant, never more widely.
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0" });
    server.serve(handlers());
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0", client: "phone-1" });
    await client.ready;
    expect(server.device()).toBe("phone-1");
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

  // The session hold rides the handshake for the reason the id does, and one
  // more: iOS suspends an app with no moment to say anything on the way out
  // (ios.md §5). So both ends settle what happens when this connection ends
  // before it has ended by any means.
  test("the two ends state the ask and the ceiling in one crossing exchange", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", holdMax: 600_000 });
    server.serve(handlers());
    const client = clientConnection(pipe.b, {
      push: recordingPush().push,
      build: "0.1.0",
      client: "phone-1",
      hold: 300_000,
    });
    // The two hellos cross rather than answer each other, so no grant travels
    // back (wire.ts `sessionHold`). The client reads the server's ceiling off
    // its hello, and the server applies that ceiling to the client's ask.
    expect((await client.ready).hold).toBe(600_000);
    expect(server.hold()).toBe(300_000);
  });

  test("an ask past the ceiling is clamped to the server's own terms", async () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", holdMax: 600_000 });
    server.serve(handlers());
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0", hold: 86_400_000 });
    await client.ready;
    expect(server.hold()).toBe(600_000);
  });

  // The desktop's case: it is not suspended out from under its connection, so
  // it does not ask. A client whose hello carries no `hold` has nothing held
  // for it (wire.ts `Hello.hold`).
  test("a client that asks for nothing is held for nothing", async () => {
    const { server, client } = connect();
    await client.ready;
    expect(server.hold()).toBe(0);
  });

  // And the stale-socket probe's case (bun/daemon.ts clearStaleSocket). A
  // socket that opened and said nothing is not a client, so a server willing
  // to grant a hold has no ask to grant.
  test("a socket that never says who it is asks for nothing", () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", holdMax: 600_000 });
    server.serve(handlers());
    expect(server.hold()).toBe(0);
  });

  // A guard stays server-side (remote.md §2). It refuses over the wire as it
  // refuses in-process, and the caller sees the guard's own words: the server
  // sends the error's message and no stack (bun/transport.ts dispatch).
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

  // The heartbeat has a direction: a client pings and a server pongs
  // (wire.ts). A client that sends a pong is out of sync.
  test("a client that answers a probe nobody sent is refused", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send(hello("client", "0.1.0"));
      client.send({ t: "pong" });
      await settle();
      expect(client.last()).toMatchObject({ t: "bye", why: "a client may not send pong" });
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

  // The handler map is an object literal, so a name reached through its
  // prototype is not a method. bun/transport.ts dispatch looks methods up with
  // Object.hasOwn for this reason.
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

  // A binary frame is claimed by the control frame right behind it (wire.ts
  // BinaryHolder). This test and the next two are the three ways a peer can
  // break that rule. All three end the connection, as a bad frame length does:
  // a stream whose framing is in doubt cannot be resynchronized.
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

  // A server sends its hello as soon as it is built, before createServer has
  // loaded the workspaces, synced the docs and loaded the vault
  // (bun/server.ts). A fast client can send a request before serve() arrives.
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

describe("a socket that will not take it all at once", () => {
  /**
   * A socket with a send buffer, like the real one. `write` takes what fits
   * and returns how much it took, and only `empty` makes room again. `taken`
   * is everything the peer would actually receive.
   */
  function fakeSocket(buffer: number) {
    const taken: number[] = [];
    let room = buffer;
    return {
      taken,
      socket: {
        write(bytes: Uint8Array): number {
          const wrote = Math.min(room, bytes.length);
          for (let i = 0; i < wrote; i++) taken.push(bytes[i]!);
          room -= wrote;
          return wrote;
        },
      },
      /** The peer read, so there is room again. Bun calls `drain` here. */
      empty() {
        room = buffer;
      },
    };
  }

  const counting = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 256);

  test("keeps the bytes the buffer would not take, and sends them on drain", () => {
    const peer = fakeSocket(8);
    const out = socketWriter(peer.socket);

    out.write(counting(20));
    // Eight bytes fit, and socketWriter holds the other twelve. Discarding
    // what `write` did not take truncates the stream with no error anywhere:
    // the reader waits on a frame length whose bytes never come.
    expect(peer.taken.length).toBe(8);

    peer.empty();
    out.drain();
    expect(peer.taken.length).toBe(16);

    peer.empty();
    out.drain();
    expect(peer.taken.length).toBe(20);
    expect(peer.taken).toEqual([...counting(20)]);
  });

  test("a write while bytes are still held queues behind them, in order", () => {
    const peer = fakeSocket(4);
    const out = socketWriter(peer.socket);

    out.write(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    out.write(Uint8Array.from([7, 8]));
    expect(peer.taken).toEqual([1, 2, 3, 4]);

    peer.empty();
    out.drain();
    peer.empty();
    out.drain();
    // 5 and 6 before 7 and 8: a stream whose second write overtook the
    // remainder of its first would corrupt every frame after it.
    expect(peer.taken).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("a socket that has gone away is not spun on", () => {
    let calls = 0;
    const out = socketWriter({
      write() {
        calls += 1;
        // What Bun returns for a socket that is closed.
        return -1;
      },
    });
    out.write(counting(100));
    out.drain();
    // One write per attempt and no more. A loop that treated -1 as "try again"
    // would spin against a dead peer.
    expect(calls).toBe(2);
  });

  test("a buffer big enough is one write and nothing held", () => {
    const peer = fakeSocket(1024);
    const out = socketWriter(peer.socket);
    out.write(counting(300));
    expect(peer.taken.length).toBe(300);
    // Nothing waiting, so a drain that arrives anyway is a no-op rather than a
    // second copy of what was already sent.
    out.drain();
    expect(peer.taken.length).toBe(300);
  });

  test("a response larger than the buffer arrives whole", () => {
    // The bug this seam was written for: 291KB of note text through the 8KB
    // send buffer macOS gives a unix socket. Without socketWriter the reader
    // got the first 8KB and then nothing.
    const peer = fakeSocket(8 * 1024);
    const out = socketWriter(peer.socket);
    const note = counting(291 * 1024);
    out.write(note);
    for (let i = 0; i < 100 && peer.taken.length < note.length; i++) {
      peer.empty();
      out.drain();
    }
    expect(peer.taken.length).toBe(note.length);
    expect(peer.taken).toEqual([...note]);
  });
});

// --- what phase 4 added -------------------------------------------------------

describe("bytes ride binary frames rather than base64 (remote.md §3)", () => {
  // The saving is on the wire only. The schema still says base64 and the view
  // still receives base64, because Electrobun's bridge is JSON either way
  // (wire.ts BINARY_FIELDS). So these tests assert two things: the payload
  // arrives intact, and the bytes did not travel inflated.
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
    // A PNG header plus a byte that is not valid UTF-8 on its own. Payloads
    // like this are why the schema carries them as base64.
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
    // Bytes that are not valid UTF-8, so a trip that handled them as text
    // would mangle them. The assertion is that the payload arrives unchanged.
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
  // Reassembles what the wire took apart. Terminal output leaves as a binary
  // frame followed by a control frame with dataB64 blanked, so a tap that read
  // only control frames would see every payload as empty.
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

  // Nagle's shape rather than a fixed delay. The first chunk after a quiet
  // moment goes out at once, so an echoed keystroke is never delayed. Only a
  // shell producing continuously is batched onto the interval.
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

  // Every message other than a terminalOutput push flushes the coalescer first
  // (bun/transport.ts send). terminalAttach's answer is the scrollback up to
  // that instant, so output held from before it would be painted on top of a
  // snapshot that already contains it.
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
  // The op log belongs to the server and is handed to each connection, so it
  // survives the connection that filled it.
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

  // The op log keys on the client as well as the op id (bun/transport.ts
  // dispatch), so a recorded outcome only ever answers the client that made
  // it. The two clients here send the same op id to make that key do the work.
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

// --- the heartbeat, from the server's side (remote.md §7) ---------------------

describe("a server and the clients that probe it", () => {
  function listen(opts: { silentMs?: number; repeat?: ReturnType<typeof ticker>["repeat"]; serve?: boolean } = {}) {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, {
      build: "0.1.0",
      ...(opts.silentMs === undefined ? {} : { silentMs: opts.silentMs }),
      ...(opts.repeat === undefined ? {} : { repeat: opts.repeat }),
    });
    if (opts.serve !== false) server.serve(handlers());
    const client = rawClient(pipe.b);
    client.send(hello("client", "0.1.0"));
    return { server, client };
  }

  // A ping is a frame the transport answers, not a request dispatched into the
  // handler map. The map arrives only once the vault has loaded, so a probe
  // queued behind a slow boot would report a dead server that is merely
  // starting.
  test("a probe is answered before the server has a single handler", async () => {
    const { client } = listen({ serve: false });
    client.send({ t: "ping" });
    await settle();
    expect(client.last()).toMatchObject({ t: "pong" });
  });

  test("a client that keeps probing is left alone", async () => {
    const beats = ticker();
    const { client } = listen({ silentMs: 40_000, repeat: beats.repeat });
    for (let i = 0; i < 5; i++) {
      client.send({ t: "ping" });
      await settle();
      beats.beat();
    }
    expect(client.isClosed()).toBe(false);
    expect(client.heard.filter((m) => m.t === "pong").length).toBe(5);
  });

  // The watchdog exists for a wire that black-holes. Without it the daemon
  // keeps a connection nobody will ever close, with its sessions open and its
  // idle exit never armed (bun/daemon.ts arms it only at zero clients).
  test("a client that says nothing is collected, and told nothing", async () => {
    await quiet(async () => {
      const beats = ticker();
      const { client } = listen({ silentMs: 40_000, repeat: beats.repeat });
      await settle();
      beats.beat();
      expect(client.isClosed()).toBe(false);
      beats.beat();
      await settle();
      expect(client.isClosed()).toBe(true);
      // No `bye`. A farewell tells the client to stop re-dialling
      // (shared/transport.ts), and this client is not reading anything.
      expect(client.heard.some((m) => m.t === "bye")).toBe(false);
    });
  });

  // The same watchdog collects a socket that connects and never greets
  // (bun/transport.ts), which would otherwise sit there as long as the process.
  test("a socket that never greets is collected too", async () => {
    await quiet(async () => {
      const beats = ticker();
      const pipe = pipePair();
      serverConnection(pipe.a, { build: "0.1.0", silentMs: 40_000, repeat: beats.repeat });
      const client = rawClient(pipe.b);
      beats.beat(2);
      await settle();
      expect(client.isClosed()).toBe(true);
    });
  });

  // This test and the next cover the two ways a connection ends, which are
  // different code paths. The second is the ordinary one: a client hanging up
  // is not this server deciding to. A watchdog left running by either leaves
  // the daemon one timer per dropped connection, on a process meant to outlive
  // them all.
  test("the watchdog stops when the server closes the connection", () => {
    const beats = ticker();
    // A bare duplex, because closing one end of a pipe hangs up the other:
    // that would clear the watchdog by the path the next test covers and prove
    // nothing about this one. Duplex does not require close() to call back,
    // and fedDuplex does not (shared/transport.ts). The daemon wraps every
    // socket it accepts in a fedDuplex (bun/daemon.ts).
    const bare: Duplex = { write: () => {}, close: () => {} };
    const server = serverConnection(bare, { build: "0.1.0", silentMs: 40_000, repeat: beats.repeat });
    expect(beats.running()).toBe(1);
    server.close();
    expect(beats.running()).toBe(0);
  });

  test("the watchdog stops when the client hangs up", async () => {
    const beats = ticker();
    const pipe = pipePair();
    serverConnection(pipe.a, { build: "0.1.0", silentMs: 40_000, repeat: beats.repeat });
    expect(beats.running()).toBe(1);
    pipe.b.close();
    await settle();
    expect(beats.running()).toBe(0);
  });
});

describe("a client that reconnects", () => {
  /** A server behind a dial() that can be cut and rebuilt. That is what a
   * dropped ssh looks like from the client's side. */
  function reconnectable(handlerMap: RequestHandlers, opts: { instance?: () => string; holdMax?: number } = {}) {
    const ops = createOpLog();
    let current: { server: ServerConnection; pipe: ReturnType<typeof pipePair>; blackHole: () => void } | null = null;
    let dials = 0;
    const dial = (): Duplex => {
      dials += 1;
      const pipe = pipePair();
      // A wire that can stop carrying bytes without closing: no FIN, no RST,
      // no exit, nothing for either end to notice. `cut` below ends the wire
      // instead, and that is what every test here but one uses. Only the
      // heartbeat can end a black-holed wire.
      let carrying = true;
      const onwards = { a: pipe.a.write, b: pipe.b.write };
      pipe.a.write = (bytes) => {
        if (carrying) onwards.a(bytes);
      };
      pipe.b.write = (bytes) => {
        if (carrying) onwards.b(bytes);
      };
      const server = serverConnection(pipe.a, {
        build: "0.1.0",
        ops,
        instance: opts.instance ? opts.instance() : "one-server",
        ...(opts.holdMax === undefined ? {} : { holdMax: opts.holdMax }),
      });
      server.serve(handlerMap);
      current = { server, pipe, blackHole: () => (carrying = false) };
      return pipe.b;
    };
    return {
      dial,
      cut: () => current?.pipe.a.close(),
      blackHole: () => current?.blackHole(),
      bye: (why: string, back = false) => current?.server.close(why, back),
      dials: () => dials,
      hold: () => current?.server.hold() ?? -1,
    };
  }

  // A ladder with no waiting in it, and no retry beat after it. `retryEveryMs:
  // 0` is the heartbeat's `everyMs: 0` one layer up: the off switch for a test
  // that is not about it. Without it a sleep that resolves instantly would dial
  // in a tight loop, and the tests below about giving up need the ladder's end
  // to be an end. The beat has its own tests further down, with a sleep they
  // can control.
  const instant = { delaysMs: [0, 0, 0], sleep: () => Promise.resolve(), retryEveryMs: 0 };

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
    // The first connection ran it. The replay is answered from the record, so
    // the caller gets an answer and the file was written once.
    expect(await pending).toEqual({ mtimeMs: 1, divergedTo: null });
    expect(writes).toBe(1);
    expect(wire.dials()).toBe(2);
  });

  // The session hold belongs to the client, not to one connection, so every
  // dial re-states it (shared/transport.ts). A reconnect that dropped it would
  // hold nothing for the next app switch, which is when a phone needs it
  // (ios.md §5). The ladder's ordinary job is a wire that flapped, so the next
  // connection is usually the one that gets suspended.
  test("every dial re-states the session hold", async () => {
    const wire = reconnectable(handlers(), { holdMax: 600_000 });
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      hold: 300_000,
      ...instant,
    });
    expect(wire.hold()).toBe(300_000);
    wire.cut();
    await client.requests.vaultState({}); // held until the ladder lands
    expect(wire.dials()).toBe(2);
    expect(wire.hold()).toBe(300_000);
  });

  // The failure the heartbeat was written for, and the only test here that
  // produces it. Every other test drops a wire by closing it, which tells this
  // end at once. A network that goes away sends nothing: no FIN, no RST, no
  // exit. Unanswered probes are the only sign of it.
  test("a wire that stops carrying bytes is noticed, and the ladder climbs back", async () => {
    const beats = ticker();
    const states: string[] = [];
    const wire = reconnectable(handlers());
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s) => states.push(s),
      heartbeat: { everyMs: 5_000, allowed: 3, repeat: beats.repeat },
      ...instant,
    });
    wire.blackHole();

    // Four beats: the first still counts the hello as traffic, then three
    // probes go unanswered. Nothing is decided yet and no state is announced.
    beats.beat(4);
    expect(states).toEqual([]);
    expect(wire.dials()).toBe(1);

    beats.beat();
    expect(await client.requests.vaultState({})).toEqual({ state: "locked" });
    expect(wire.dials()).toBe(2);
    expect(states).toEqual(["reconnecting", "live"]);
    // The dead connection's timer stopped with it, and the new connection runs
    // one of its own.
    expect(beats.running()).toBe(1);
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

  // A handler saying no is an answer, so it is final. Only a transport failure
  // is replayed (shared/transport.ts ConnectionLost). Otherwise every refusal
  // would be retried against a server that already refused it.
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
  });

  // The client reconnects to a restarted server rather than refusing it. The
  // daemon idles out a minute after its last client leaves (bun/daemon.ts), so
  // a laptop that slept wakes to a different process than the one it left, and
  // refusing meant somebody had to fix that overnight case by hand. Both
  // announcements matter: remote.md §7 says what `lost` and `live` settle.
  test("and then talks to it, saying plainly that everything it was holding is gone", async () => {
    let n = 0;
    const wire = reconnectable(handlers(), { instance: () => `run-${++n}` });
    const states: string[] = [];
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s, d) => states.push(`${s}:${d}`),
      ...instant,
    });
    wire.cut();
    expect(await client.requests.vaultState({})).toEqual({ state: "locked" });
    expect(states).toEqual([
      "reconnecting:The connection dropped. Reconnecting…",
      "lost:The server restarted, so everything it was holding is gone.",
      "live:",
    ]);
  });

  // Only a request carrying an op is failed across a restart (wire.ts
  // needsOp). A write replayed into an empty record could apply twice. A read
  // asks about right now, so any server can answer it.
  test("a read in flight across a restart is carried; a write is not", async () => {
    let n = 0;
    let slow!: () => void;
    const waited = new Promise<void>((r) => (slow = r));
    const wire = reconnectable(
      handlers({
        noteWrite: () => new Promise(() => {}),
        vaultState: async () => {
          await waited; // the answer the first server never gets to send
          return { state: "locked" };
        },
      }),
      { instance: () => `run-${++n}` },
    );
    const client = await reconnectingClient({ dial: wire.dial, push: recordingPush().push, build: "0.1.0", ...instant });
    const read = client.requests.vaultState({});
    const write = client.requests.noteWrite({ path: "/a.md", text: "x", baseMtimeMs: null });
    await settle();
    slow();
    wire.cut();
    await expect(write).rejects.toThrow("One request could not be finished: the server restarted.");
    expect(await read).toEqual({ state: "locked" });
  });

  // With no retry beat under it (`retryEveryMs: 0`), the shape a one-shot
  // wants: a client with somewhere else to be stops instead of dialling
  // forever. The app's shape, which keeps dialling, is tested further down.
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
    // The request in flight fails with the dial's reason instead of waiting
    // on a wire that is not coming back.
    await expect(pending).rejects.toThrow("host is down");
    expect(states.at(-1)).toContain("lost:");
    // New requests are refused too. An app that keeps taking requests for a
    // server it cannot reach looks like it is working.
    await expect(client.requests.vaultState({})).rejects.toThrow("There is no connection to the server.");
  });

  // --- and the ladder that does not end -----------------------------------
  //
  // Every test above sets `retryEveryMs: 0`, because they are about the
  // ladder. These are about the beat that runs after it. An outage longer than
  // the ladder used to be permanent: a closed lid, a flight, a hotel with a
  // captive portal.

  /** A sleep that stays open until a test releases it. Every `sleep` in the
   * client comes through here, the ladder's rungs and the beat alike, so a
   * test controls exactly how many waits it is releasing. */
  function pacer() {
    let waiting: Array<() => void> = [];
    return {
      sleep: () => new Promise<void>((resolve) => waiting.push(resolve)),
      /** Resolves every wait outstanding now, then settles what they start. */
      async release(): Promise<void> {
        for (const resolve of waiting.splice(0)) resolve();
        await settle();
      },
      waiting: () => waiting.length,
    };
  }

  /** A server that can be taken away and put back, standing in for a network
   * rather than a peer. While it is down `dial` throws, the way ssh does. */
  function flaky() {
    let up = true;
    let dials = 0;
    let cut: () => void = () => {};
    const ops = createOpLog();
    return {
      dial: (): Duplex => {
        dials += 1;
        if (!up) throw new Error("host is down");
        const pipe = pipePair();
        serverConnection(pipe.a, { build: "0.1.0", instance: "one-server", ops }).serve(handlers());
        cut = () => pipe.a.close();
        return pipe.b;
      },
      down: () => {
        up = false;
        cut();
      },
      up: () => (up = true),
      dials: () => dials,
    };
  }

  test("a ladder that runs out keeps dialling, and comes back on its own", async () => {
    const net = flaky();
    const beats = pacer();
    const states: string[] = [];
    const client = await reconnectingClient({
      dial: net.dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s, d) => states.push(`${s}:${d}`),
      delaysMs: [0],
      sleep: beats.sleep,
      retryEveryMs: 30_000,
    });
    net.down();
    await settle();
    await beats.release(); // the ladder's one rung, which finds nothing
    expect(states.at(-1)).toBe("lost:Lost the connection: host is down.");

    const spent = net.dials();
    await beats.release(); // a beat, still nothing there
    expect(net.dials()).toBe(spent + 1);
    expect(states.at(-1)).toContain("lost:");

    net.up();
    await beats.release(); // and one that lands
    expect(states.at(-1)).toBe("live:");
    expect(await client.requests.vaultState({})).toEqual({ state: "locked" });
    client.close();
  });

  // The beat does not change what `lost` means. A request made while the beat
  // is running fails at once instead of waiting for the next dial. Waiting on
  // a wire that is dialled every half minute would make a disconnected app
  // look like a working one.
  test("a client that is still trying is still lost, and says so at once", async () => {
    const net = flaky();
    const beats = pacer();
    const client = await reconnectingClient({
      dial: net.dial,
      push: recordingPush().push,
      build: "0.1.0",
      delaysMs: [0],
      sleep: beats.sleep,
      retryEveryMs: 30_000,
    });
    net.down();
    await settle();
    await beats.release();
    await expect(client.requests.vaultState({})).rejects.toThrow("There is no connection to the server.");
    client.close();
  });

  // `recheck` is what a woken laptop, a network coming back and a pressed
  // Reconnect button all call. The beat is half a minute wide, so a lid that
  // opens onto a working network would otherwise wait through it.
  test("a recheck brings the next beat forward instead of waiting for it", async () => {
    const net = flaky();
    const beats = pacer();
    const client = await reconnectingClient({
      dial: net.dial,
      push: recordingPush().push,
      build: "0.1.0",
      delaysMs: [0],
      sleep: beats.sleep,
      retryEveryMs: 30_000,
    });
    net.down();
    await settle();
    await beats.release();
    const spent = net.dials();

    net.up();
    client.recheck();
    await settle();
    expect(net.dials()).toBe(spent + 1);
    expect(await client.requests.vaultState({})).toEqual({ state: "locked" });
    client.close();
  });

  // A beat that outlived `close` would dial a server the app has already let
  // go of. On a connection switch that is an ssh child spawned against the
  // machine the app just left.
  test("closing stops the beat", async () => {
    const net = flaky();
    const beats = pacer();
    const client = await reconnectingClient({
      dial: net.dial,
      push: recordingPush().push,
      build: "0.1.0",
      delaysMs: [0],
      sleep: beats.sleep,
      retryEveryMs: 30_000,
    });
    net.down();
    await settle();
    await beats.release();
    const spent = net.dials();

    client.close();
    await beats.release();
    await beats.release();
    expect(net.dials()).toBe(spent);
  });

  // The same rule one dial later. A lost client waits half a minute between
  // dials, so a connection switch usually closes it mid-wait. Adopting the
  // connection that lands would put a live wire on a closed client, pointed at
  // the machine the app just left.
  test("a dial that lands after the client was closed is thrown away", async () => {
    const net = flaky();
    const beats = pacer();
    const client = await reconnectingClient({
      dial: net.dial,
      push: recordingPush().push,
      build: "0.1.0",
      delaysMs: [0],
      sleep: beats.sleep,
      retryEveryMs: 30_000,
    });
    net.down();
    await settle();
    await beats.release();

    // The server is back and the beat is released just after the close, so
    // the dial succeeds and finds a client that has already finished.
    net.up();
    client.close();
    await beats.release();
    await expect(client.requests.vaultState({})).rejects.toThrow("There is no connection to the server.");
  });

  // A broken wire carries no reason, so a `bye` with one means the server
  // chose to hang up, and the ladder answers the broken wire only. The daemon
  // replaces a connection with a later one from the same client
  // (bun/daemon.ts). If the displaced connection re-dialled, the two would
  // replace each other for as long as both ran, at an ssh handshake per turn.
  test("a server that says goodbye is not dialled again", async () => {
    const wire = reconnectable(handlers());
    const states: string[] = [];
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s, d) => states.push(`${s}:${d}`),
      ...instant,
    });
    wire.bye("another client connected to this server");
    await settle();
    expect(wire.dials()).toBe(1);
    // The server's own words. "The connection dropped" would send the user
    // looking at their network for a fault that is not there.
    expect(states).toEqual(["lost:Disconnected: another client connected to this server."]);
    await expect(client.requests.vaultState({})).rejects.toThrow("There is no connection to the server.");
  });

  // The beat does not resume after a final `bye` either. A spent ladder means
  // nobody answered, so dialling again is worth trying; a `bye` is an answer.
  // A displaced connection that kept beating would take the client back from
  // the connection that replaced it, twice a minute forever, at an ssh
  // handshake apiece.
  test("and a beat does not talk it round", async () => {
    const wire = reconnectable(handlers());
    const beats = pacer();
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      delaysMs: [0],
      sleep: beats.sleep,
      retryEveryMs: 30_000,
    });
    wire.bye("another client connected to this server");
    await settle();
    await beats.release();
    await beats.release();
    expect(wire.dials()).toBe(1);
    expect(beats.waiting()).toBe(0);
    client.close();
  });

  // The exception, and the one the daemon sends (bun/daemon.ts stop). A server
  // saying it is coming back has decided about this connection, not about this
  // client (wire.ts `bye`). Every graceful stop is this: an idle exit, a
  // `systemctl restart`, the SIGTERM behind a `pkill`. Reading it as final left
  // the window disconnected with a Reconnect that had nothing to dial, until
  // someone opened another window.
  test("but a server that says it is coming back is dialled again", async () => {
    const wire = reconnectable(handlers());
    const states: string[] = [];
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s, d) => states.push(`${s}:${d}`),
      ...instant,
    });
    wire.bye("this server is shutting down", true);
    await settle();
    expect(wire.dials()).toBe(2);
    // The server's own words on the way down, too. Saying "the connection
    // dropped" about a server that announced it was stopping sends the user
    // looking at their network for a fault that is not there.
    expect(states).toEqual(["reconnecting:This server is shutting down. Reconnecting…", "live:"]);
    expect(await client.requests.vaultState({})).toBeDefined();
    client.close();
  });

  // The Reconnect button, in the one state where it used to do nothing
  // (interactions.md §4-1). A client told the goodbye was final never dials
  // again on its own. The press supplies the one fact the client cannot have:
  // a person can see the machine is back.
  test("and a press dials even a client that was told the goodbye was final", async () => {
    const wire = reconnectable(handlers());
    const states: string[] = [];
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s, d) => states.push(`${s}:${d}`),
      ...instant,
    });
    wire.bye("this client opened another connection to this server");
    await settle();
    expect(wire.dials()).toBe(1);
    client.recheck();
    await settle();
    expect(wire.dials()).toBe(2);
    expect(states.at(-1)).toBe("live:");
    expect(await client.requests.vaultState({})).toBeDefined();
    client.close();
  });

  // One dial per press, not a second ssh child racing the first. A press does
  // nothing while the client is already dialling.
  test("a press while something is already dialling is the no-op it should be", async () => {
    const wire = reconnectable(handlers());
    const beats = pacer();
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      delaysMs: [30_000],
      sleep: beats.sleep,
      retryEveryMs: 30_000,
    });
    wire.cut();
    await settle();
    // Mid-ladder: the next rung is coming and pressing does not add one.
    client.recheck();
    client.recheck();
    await settle();
    expect(wire.dials()).toBe(1);
    await beats.release();
    expect(wire.dials()).toBe(2);
    client.close();
  });

  // The same failure with no `bye` behind it: a server that crashes as it
  // boots, an ssh killed with its session, a forced command that exits. The
  // ladder used to start over on every success, so a connection that died the
  // moment it was made had an unbounded budget one rung at a time
  // (shared/transport.ts STEADY_MS).
  test("a connection that dies as soon as it is made does not buy a fresh ladder", async () => {
    let dials = 0;
    const dial = (): Duplex => {
      dials += 1;
      const pipe = pipePair();
      // Cut on the handshake rather than before it. A dial that never
      // completed is an ordinary failure; this one connects first, so it
      // counts as a recovery before it dies.
      const server = serverConnection(pipe.a, {
        build: "0.1.0",
        instance: "one-server",
        greeted: () => pipe.a.close(),
      });
      server.serve(handlers());
      return pipe.b;
    };
    const states: string[] = [];
    const client = await reconnectingClient({
      dial,
      push: recordingPush().push,
      build: "0.1.0",
      onState: (s, d) => states.push(`${s}:${d}`),
      // A clock that does not move, so every connection lasts zero ms and none
      // of them reaches STEADY_MS. That is the case under test, not a
      // fixture's convenience.
      now: () => 0,
      ...instant,
    });
    await settle();
    // One boot dial plus the ladder's three rungs, and then it stops. Each
    // rung connects and drops, so the indicator alternates live and
    // reconnecting the whole way. The dial count is what says the ladder was
    // bounded.
    expect(dials).toBe(1 + instant.delaysMs.length);
    expect(states.at(-1)).toContain("lost:");
    await expect(client.requests.vaultState({})).rejects.toThrow("There is no connection to the server.");
  });

  // The other half of the rule. A connection that lasted STEADY_MS earns the
  // whole ladder back, so an ordinary drop on a long session is not treated as
  // a flap.
  test("a connection that held gets the whole ladder again", async () => {
    const wire = reconnectable(handlers());
    let clock = 0;
    const client = await reconnectingClient({
      dial: wire.dial,
      push: recordingPush().push,
      build: "0.1.0",
      now: () => clock,
      ...instant,
    });
    // Four drops, each after a connection that held for a minute. A ladder
    // that only ever advanced would have run out on the fourth.
    for (let i = 0; i < 4; i++) {
      clock += 60_000;
      wire.cut();
      expect(await client.requests.vaultState({})).toEqual({ state: "locked" });
    }
    expect(wire.dials()).toBe(5);
  });
});
