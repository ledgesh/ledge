// The two ends of a connection, run against each other over a pipe made of
// promises. What this covers that wire.test.ts cannot is the conversation:
// who speaks first, what happens to a request whose server has not finished
// booting, and how a server answers a client that is not following the rules.
//
// The client's half lives in shared/transport.ts now, so the tests that need
// only a client — the handshakes it refuses, and fedDuplex — are in
// shared/transport.test.ts, which imports nothing from this directory. What
// stays here is everything with a server in it, because that is what a server
// is: the handler map, the coalescer, and the op log a replay is deduped
// against.
//
// No processes here either. spawnDuplex and stdioDuplex are three lines of Bun
// API each and are exercised for real in serve.fs.test.ts, which is the only
// place a pipe can actually break.
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

/** A timer cranked by hand, for the heartbeat at both ends: forty seconds of
 * silence costs a function call, and no test below waits for a clock. */
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

  // The session hold rides the handshake for the reason the id does, and one
  // more: a client the operating system suspends is given no moment to say
  // anything on the way out (ios.md §5), so what should happen when this
  // connection ends is stated before it has ended by any means.
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
    // Each end knows the granted number from its own side of the pair; nothing
    // travels back to tell either (wire.ts `sessionHold`).
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

  // The desktop's case: it is not suspended out from under its connection and
  // does not ask, so nothing is held for it.
  test("a client that asks for nothing is held for nothing", async () => {
    const { server, client } = connect();
    await client.ready;
    expect(server.hold()).toBe(0);
  });

  // And the stale-socket probe's case (daemon.ts clearStaleSocket): a socket
  // that opened and said nothing is not a client, so there is no ask to grant
  // even from a server willing to grant one.
  test("a socket that never says who it is asks for nothing", () => {
    const pipe = pipePair();
    const server = serverConnection(pipe.a, { build: "0.1.0", holdMax: 600_000 });
    server.serve(handlers());
    expect(server.hold()).toBe(0);
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

  // The heartbeat has a direction (wire.ts): a client asks and a server
  // answers, so a client that answers is a client out of sync.
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

describe("a socket that will not take it all at once", () => {
  /**
   * A socket with a send buffer, like the real one: it takes what fits and says
   * so, and only a drain makes room. `taken` is everything the peer would
   * actually receive.
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
      /** The peer read: room again, which is when Bun calls `drain`. */
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
    // Eight bytes fit. The other twelve are this end's to remember: discarding
    // what `write` did not take is the truncation this whole seam exists to
    // stop, and it is silent — the reader is left waiting on a frame length
    // whose bytes never come.
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
    // Once per attempt and no more: a loop that treated -1 as "try again"
    // would burn a core against a dead peer.
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
    // The shape of the bug this seam was written for: 291KB of note text
    // through a send buffer of 8KB, which is what macOS gives a unix socket.
    // Before this, the reader got the first 8KB and then nothing, forever.
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

  // Answered by the transport rather than dispatched into the handler map,
  // which is the whole reason it is a frame and not a request: the map arrives
  // once the vault has loaded, and a probe queued behind a slow boot would
  // report a dead server that is merely starting.
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

  // The ghost this exists for: a wire that black-holes leaves the daemon a
  // connection nobody will ever close, its sessions open and its idle exit
  // never armed.
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
      // No `bye`, and that is deliberate: a farewell is a decision the client
      // is meant to read and stop re-dialling over (shared/transport.ts), and
      // this one is not reading anything.
      expect(client.heard.some((m) => m.t === "bye")).toBe(false);
    });
  });

  // A socket that connects and never identifies itself used to sit there for
  // as long as the process did.
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

  // Both ways a connection ends, because they are different code paths and the
  // second is the ordinary one: a client hanging up is not this server
  // deciding to. A watchdog left behind by either is a timer per dropped
  // connection, forever, on the process meant to outlive them all.
  test("the watchdog stops when the server closes the connection", () => {
    const beats = ticker();
    // Over a duplex whose close() does not call back, because a pipe's does:
    // closing one end of a pipe hangs up the other, which would clear this by
    // the path the test below is about and prove nothing about this one.
    // Duplex promises no such courtesy — fedDuplex gives none
    // (shared/transport.ts), and that is what the iOS shell hands over.
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
  /** A server behind a dial() that can be cut and rebuilt, which is what a
   * dropped ssh looks like from this side. */
  function reconnectable(handlerMap: RequestHandlers, opts: { instance?: () => string; holdMax?: number } = {}) {
    const ops = createOpLog();
    let current: { server: ServerConnection; pipe: ReturnType<typeof pipePair>; blackHole: () => void } | null = null;
    let dials = 0;
    const dial = (): Duplex => {
      dials += 1;
      const pipe = pipePair();
      // A wire that can stop carrying bytes without closing: no FIN, no RST,
      // no exit, nothing for either end to notice. `cut` below is a wire that
      // ENDED, which every test but one here is about; this is the one that
      // only the heartbeat can end.
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
      bye: (why: string) => current?.server.close(why),
      dials: () => dials,
      hold: () => current?.server.hold() ?? -1,
    };
  }

  // A ladder with no waiting in it, and no beat after it. `retryEveryMs: 0` is
  // the heartbeat's `everyMs: 0` one layer up: the tests below that are about
  // giving up need the moment the ladder ends to be an ENDING, and a fixture
  // whose sleep resolves instantly would otherwise dial in a tight loop. The
  // beat has its own tests, with a sleep it can be watched through.
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
    // The first connection ran it; the replay is answered from the record, so
    // the caller gets an answer and the file was written once.
    expect(await pending).toEqual({ mtimeMs: 1, divergedTo: null });
    expect(writes).toBe(1);
    expect(wire.dials()).toBe(2);
  });

  // The ask is a property of the CLIENT, not of one connection. A reconnect
  // that dropped it would hold nothing for the app switch after this one, which
  // is exactly when a phone needs it (ios.md §5) — and the ladder's ordinary
  // job is a wire that flapped, so the next connection is usually the one that
  // will be suspended.
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

  // The failure everything else in this file is unable to produce, and the one
  // the heartbeat was written for. Every other test here drops a wire by
  // CLOSING it, which tells this end immediately. A network that goes away
  // does neither: no FIN, no RST, no exit, and until the probes went unanswered
  // there was nothing to notice.
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

    // Four beats: one that heard the hello, then three probes into the dark.
    // Nothing has been decided, and nothing has been said to anybody.
    beats.beat(4);
    expect(states).toEqual([]);
    expect(wire.dials()).toBe(1);

    beats.beat();
    expect(await client.requests.vaultState({})).toEqual({ state: "locked" });
    expect(wire.dials()).toBe(2);
    expect(states).toEqual(["reconnecting", "live"]);
    // The dead connection's timer went with it, and the new one has its own.
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
  });

  // And then talks to it. Refusing was the old answer, and it made the ordinary
  // overnight case unrecoverable without a human: the daemon idles out a minute
  // after its last client leaves, so a laptop that slept ALWAYS wakes to a
  // different process than the one it left.
  //
  // The pair of announcements is the load-bearing part. `lost` is what suspends
  // saving above and `live` is what settles the buffers against a server that
  // has moved on (notes/store.ts, workspace/editorPool.ts), so a restart that
  // reported only `live` would let a stale buffer win exactly the argument this
  // whole phase is about.
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

  // The op line, drawn where the op log draws it: a write cannot be replayed
  // into an empty record, and a read is a question about right now.
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

  // With no beat under it (`retryEveryMs: 0`), which is the shape a one-shot
  // wants: a client with somewhere else to be should not be kept alive by its
  // own hope. The app's shape is the test below this one.
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

  // --- and the ladder that does not end -----------------------------------
  //
  // Every test above turns the beat off, because they are about the ladder.
  // These are about what happens after it, which is the difference between an
  // outage that costs a pause and one that costs the session: a closed lid, a
  // flight, a hotel with a captive portal are all longer than thirty seconds,
  // and all of them used to be permanent.

  /** A sleep held open, so a beat can be watched rather than waited for. Every
   * `sleep` in the client comes through here — the ladder's rungs and the beat
   * alike — so a test says exactly how many waits it is releasing. */
  function pacer() {
    let waiting: Array<() => void> = [];
    return {
      sleep: () => new Promise<void>((resolve) => waiting.push(resolve)),
      /** Let every current wait finish, and let what it starts settle. */
      async release(): Promise<void> {
        for (const resolve of waiting.splice(0)) resolve();
        await settle();
      },
      waiting: () => waiting.length,
    };
  }

  /** A server that can be taken away and put back, which is a network rather
   * than a peer: `dial` throws while it is down, exactly as ssh does. */
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

  // The half that must NOT change with it. A beating client is still lost, and
  // lost still means an answer now rather than a wait: a request that hung on
  // the next half-minute would be the disconnected app that looks like a working
  // one, which is the whole thing this is for.
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

  // What a woken laptop, a network coming back and a pressed button all reach.
  // Worth its own path because the beat is half a minute wide: a lid that opens
  // onto a working network should not spend any of it.
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

  // A client that has been closed is finished, and a beat that outlived it
  // would dial a server the app has already let go of — on a switch, that is
  // an ssh child spawned against the machine you just left.
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

  // The same rule one step later, and the beat is what makes it ordinary: a
  // lost client sits in a dial for half a minute at a time, so a switch lands
  // in the middle of one routinely. Adopting what comes back would put a live
  // wire on a closed client, pointed at the machine the app just left.
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

    // The server is back, and the beat is released in the same breath as the
    // close: the dial succeeds, and finds a client that has finished.
    net.up();
    client.close();
    await beats.release();
    await expect(client.requests.vaultState({})).rejects.toThrow("There is no connection to the server.");
  });

  // A wire cannot say anything, so a reason means the server DECIDED. The
  // ladder is for the other case, and running it against a decision is an
  // argument with a server that has already answered: the daemon serves one
  // client and gives the session to whoever dialled last, so two clients that
  // both re-dialled "another client connected" would displace each other for
  // as long as both were running, several times a second, at an ssh handshake
  // and a server process per turn.
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
    // In the server's own words, because "the connection dropped" would send
    // the user looking at their network for something that is not there.
    expect(states).toEqual(["lost:Disconnected: another client connected to this server."]);
    await expect(client.requests.vaultState({})).rejects.toThrow("There is no connection to the server.");
  });

  // The whole point of the split. A ladder that ran out is a wire nobody could
  // ask, and it keeps asking; a `bye` is an answer, and no amount of beating
  // improves on it. Displacement is what bites: the daemon serves one client and
  // gives the session to whoever dialled last, so two beating clients would kick
  // each other off twice a minute forever, at an ssh handshake apiece.
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

  // The general shape of the same failure, for every cause that does NOT come
  // with a bye: a server that crashes as it boots, an ssh killed with its
  // session, a forced command that exits. The ladder ends, but it used to start
  // over on every success, so a connection that died the moment it was made had
  // an unbounded budget one rung at a time.
  test("a connection that dies as soon as it is made does not buy a fresh ladder", async () => {
    let dials = 0;
    const dial = (): Duplex => {
      dials += 1;
      const pipe = pipePair();
      // Cut on the handshake and not before it: a dial that never completed is
      // an ordinary failure, and what has to be caught here is the one that
      // LOOKS like a recovery.
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
      // A clock that does not move: every connection is instantaneous, which
      // is the property being tested rather than a fixture's convenience.
      now: () => 0,
      ...instant,
    });
    await settle();
    // One boot dial plus the ladder's three rungs, and then it stops. The
    // states alternate live/reconnecting the whole way, which is precisely what
    // a user watching the indicator sees, and precisely why the count matters.
    expect(dials).toBe(1 + instant.delaysMs.length);
    expect(states.at(-1)).toContain("lost:");
    await expect(client.requests.vaultState({})).rejects.toThrow("There is no connection to the server.");
  });

  // The other half of the rule, and the one that would bite a real user: a
  // connection that HELD earns the whole ladder back, so an ordinary drop on a
  // long session is never mistaken for a flap.
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
    // Four drops, each after a connection that stood up for a minute. A ladder
    // that only ever advanced would have run out on the fourth.
    for (let i = 0; i < 4; i++) {
      clock += 60_000;
      wire.cut();
      expect(await client.requests.vaultState({})).toEqual({ state: "locked" });
    }
    expect(wire.dials()).toBe(5);
  });
});
