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
import { clientConnection, serverConnection, type Duplex } from "./transport";
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
    const server = serverConnection(pipe.a, "0.1.0");
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
    serverConnection(pipe.a, "9.9.9").serve(handlers());
    const client = clientConnection(pipe.b, { push: recordingPush().push, build: "0.1.0" });
    expect((await client.ready).build).toBe("9.9.9");
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
    const server = serverConnection(pipe.a, "0.1.0");
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

  test("a binary frame ends the connection, because nothing routes one yet", async () => {
    await quiet(async () => {
      const { client } = listen();
      client.send(hello("client", "0.1.0"));
      client.raw(encodeBinary(1, new Uint8Array([1, 2, 3])));
      await settle();
      expect(client.last()).toMatchObject({ t: "bye", why: "binary frames are not routed yet" });
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
