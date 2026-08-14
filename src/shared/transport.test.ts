// The client's half on its own, with nothing from src/bun in the room.
//
// bun/transport.test.ts covers the CONVERSATION, which needs a server and so
// belongs where the server does. This file covers what the client does when
// the other end is a hand of bytes: the handshake it refuses, the failures it
// reports, and fedDuplex, which is the transport a caller drives itself —
// Bun.listen's data callback today and Swift calling into the webview on iOS
// (ios.md §2).
//
// The imports are the assertion. If this file ever needs `../bun/anything`,
// the split in phase 1 of ios.md has come undone, and portable.test.ts says so
// in the general case.
import { describe, expect, test } from "bun:test";
import { clientConnection, fedDuplex, type Duplex, type HeartbeatOpts } from "./transport";
import {
  CONTROL_FRAME,
  encodeControl,
  FrameDecoder,
  hello,
  parseControl,
  PUSH_MESSAGES,
  type Hello,
  type ServerPush,
  type WireMessage,
} from "./wire";

/** A server that is entirely under the test's thumb: it says exactly what it
 * is told to say, and records what the client said back. */
function peer() {
  const heard: WireMessage[] = [];
  const decoder = new FrameDecoder();
  let writes = 0;
  let closed = false;
  const duplex = fedDuplex({
    write(bytes) {
      writes += 1;
      for (const frame of decoder.push(bytes)) if (frame.type === CONTROL_FRAME) heard.push(parseControl(frame.text));
    },
    close() {
      closed = true;
    },
  });
  return {
    duplex,
    heard,
    writes: () => writes,
    isClosed: () => closed,
    say: (msg: WireMessage) => duplex.feed(encodeControl(msg)),
    greet: (over: Partial<Hello> = {}) => duplex.feed(encodeControl({ ...hello("server", "0.1.0", "", "one-server"), ...over })),
    hangUp: () => duplex.finish(),
  };
}

function nowherePush(): ServerPush {
  return Object.fromEntries(PUSH_MESSAGES.map((m) => [m, () => {}])) as unknown as ServerPush;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- the duplex somebody else drives -----------------------------------------

describe("fedDuplex", () => {
  function sink(): { io: { write(b: Uint8Array): void; close(): void }; wrote: Uint8Array[]; closed: () => boolean } {
    const wrote: Uint8Array[] = [];
    let shut = false;
    return {
      io: { write: (b) => wrote.push(b), close: () => (shut = true) },
      wrote,
      closed: () => shut,
    };
  }

  // The race the buffering exists for: creating a duplex and giving it to a
  // connection is two statements, and a server greets the moment it is built.
  test("bytes fed before anyone is listening are delivered when someone is, in order", () => {
    const d = fedDuplex(sink().io);
    d.feed(new Uint8Array([1]));
    d.feed(new Uint8Array([2]));
    const seen: number[] = [];
    d.onData = (chunk) => seen.push(...chunk);
    expect(seen).toEqual([1, 2]);
    d.feed(new Uint8Array([3]));
    expect(seen).toEqual([1, 2, 3]);
  });

  // A peer that says its piece and hangs up immediately still gets read: the
  // close must not overtake the bytes that came before it. Asserted in BOTH
  // attach orders, because a consumer setting onClose first is a consumer that
  // would otherwise be told the wire is gone before it hears the last thing
  // said on it — and the Swift shell is a consumer this file has never seen.
  test.each([
    ["onData first", true],
    ["onClose first", false],
  ])("a hangup before anyone is listening waits for the bytes to be read (%s)", (_name, dataFirst) => {
    const d = fedDuplex(sink().io);
    d.feed(new Uint8Array([7]));
    d.finish();
    const order: string[] = [];
    const data = () => (d.onData = (chunk) => order.push(`data:${chunk[0]}`));
    const close = () => (d.onClose = () => order.push("close"));
    if (dataFirst) {
      data();
      close();
    } else {
      close();
      data();
    }
    expect(order).toEqual(["data:7", "close"]);
  });

  test("a hangup after a reader attached closes once, however often it is finished", () => {
    const d = fedDuplex(sink().io);
    let closes = 0;
    d.onData = () => {};
    d.onClose = () => (closes += 1);
    d.finish();
    d.finish();
    expect(closes).toBe(1);
  });

  test("onClose set after a hangup still fires", () => {
    const d = fedDuplex(sink().io);
    d.onData = () => {};
    d.finish();
    let closed = false;
    d.onClose = () => (closed = true);
    expect(closed).toBe(true);
  });

  test("write and close reach the transport underneath", () => {
    const s = sink();
    const d = fedDuplex(s.io);
    d.write(new Uint8Array([9]));
    d.close();
    expect(s.wrote).toEqual([new Uint8Array([9])]);
    expect(s.closed()).toBe(true);
  });
});

// --- the client, fed by hand --------------------------------------------------

describe("a client over a duplex someone else feeds", () => {
  test("it greets first, then answers what the server sends back", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    // The client's hello is on the wire before anything has been fed to it.
    expect(server.heard[0]?.t).toBe("hello");
    server.greet();
    expect((await client.ready).instance).toBe("one-server");

    const pending = client.requests.vaultState({});
    await settle();
    const req = server.heard.at(-1);
    expect(req).toMatchObject({ t: "req", m: "vaultState" });
    server.say({ t: "res", id: (req as { id: number }).id, r: { state: "locked" } });
    expect(await pending).toEqual({ state: "locked" });
  });
});

describe("a client facing a server that will not talk", () => {
  test("a server that hangs up without a hello fails the connection", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.hangUp();
    await expect(client.ready).rejects.toThrow(/connection to the server closed/);
  });

  test("a refused handshake reaches the client as the server's own words", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.say({ t: "bye", why: "protocol version 1 on the client, 2 here" });
    await expect(client.ready).rejects.toThrow("protocol version 1 on the client, 2 here");
  });

  test("a server on another schema is refused before any request is sent", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet({ schema: "deadbeef", build: "0.9.0" });
    await expect(client.ready).rejects.toThrow(/deadbeef/);
    await expect(client.requests.vaultState({})).rejects.toThrow(/deadbeef/);
    // The client's own hello and nothing after it: a request never went out
    // over a connection whose protocol was already in doubt.
    expect(server.writes()).toBe(1);
  });

  // Not a hang. A caller that awaits a request on a connection that is already
  // gone has to be told so, or the app sits on a promise nothing will settle.
  test("a request made after the wire died rejects rather than waiting", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet();
    await client.ready;
    server.hangUp();
    await expect(client.requests.vaultState({})).rejects.toThrow(/connection to the server closed/);
  });

  test("closing the client closes the duplex under it", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet();
    await client.ready;
    client.close();
    expect(server.isClosed()).toBe(true);
    await client.closed;
  });
});

// --- the heartbeat (remote.md §7) ---------------------------------------------

/** The heartbeat's timer, cranked by hand. Twenty seconds of silence costs a
 * function call here, so nothing below waits for a clock — which is the reason
 * the timer is injectable at all. */
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
    /** How many timers are live, which is how a cancelled one is proved. */
    running: () => ticks.size,
  };
}

describe("a client whose wire has gone quiet", () => {
  function connect(over: HeartbeatOpts = {}) {
    const server = peer();
    const beats = ticker();
    const client = clientConnection(server.duplex, {
      push: nowherePush(),
      build: "0.1.0",
      heartbeat: { everyMs: 5_000, allowed: 3, repeat: beats.repeat, ...over },
    });
    return { server, beats, client, probes: () => server.heard.filter((m) => m.t === "ping").length };
  }

  // The whole trace, once, because every count below is read off it. Beat 1
  // has just heard the server's hello and said its own, so it asks nothing;
  // beats 2, 3 and 4 each send a probe into the dark; beat 5 is the one that
  // gives up, having asked three times and been ignored three times.
  test("it is given up on after three probes go unanswered, and not before", async () => {
    const { server, beats, client, probes } = connect();
    server.greet();
    await client.ready;

    beats.beat();
    expect(probes()).toBe(0);
    beats.beat(3);
    expect(probes()).toBe(3);
    // Nothing has been decided yet: an answer to any of those three would
    // still arrive in time.
    expect(server.isClosed()).toBe(false);

    // Both ways a request can meet the verdict: one already in the pending map
    // when it lands, and one that reaches `call` a moment after. Each has to
    // say why, or the app reports a wire that closed for a wire that was never
    // closed at all.
    const inFlight = client.requests.vaultState({});
    await settle();
    beats.beat();
    expect(server.isClosed()).toBe(true);
    await expect(inFlight).rejects.toThrow(/stopped answering/);
    await expect(client.requests.vaultState({})).rejects.toThrow(/stopped answering/);
    await client.closed;
  });

  test("an answer buys the whole budget again", async () => {
    const { server, beats, client, probes } = connect();
    server.greet();
    await client.ready;
    beats.beat(2);
    expect(probes()).toBe(1);
    server.say({ t: "pong" });
    // Four more beats: three fresh probes, and then the beat that would have
    // been fatal had that pong counted for nothing. Three beats here would
    // survive either way, which is a test that proves nothing.
    beats.beat(4);
    expect(server.isClosed()).toBe(false);
    beats.beat();
    expect(server.isClosed()).toBe(true);
  });

  // The rule that exists for the far end rather than for this one: a client
  // watching a build scroll past hears constantly and would otherwise say
  // nothing for the length of the build, which is exactly what the server
  // collects a connection for (bun/transport.ts silentMs).
  test("a client that is only listening still speaks", async () => {
    const { server, beats, client, probes } = connect();
    server.greet();
    await client.ready;
    for (let i = 0; i < 5; i++) {
      server.say({ t: "pong" });
      beats.beat();
    }
    // One on every beat but the first, which still counts this client's own
    // hello as having spoken.
    expect(probes()).toBe(4);
    expect(server.isClosed()).toBe(false);
  });

  test("a wire busy in both directions is never probed", async () => {
    const { server, beats, client, probes } = connect();
    server.greet();
    await client.ready;
    for (let i = 0; i < 5; i++) {
      const pending = client.requests.vaultState({});
      await settle();
      const req = server.heard.at(-1) as { id: number };
      server.say({ t: "res", id: req.id, r: { state: "locked" } });
      await pending;
      beats.beat();
    }
    expect(probes()).toBe(0);
  });

  // A bound the handshake never had. `ConnectTimeout` covers a dial that does
  // not land; a server that accepts the connection and then says nothing at all
  // left `ready` pending for as long as the app was open.
  test("a server that accepts a connection and never greets is given up on", async () => {
    const { beats, client, probes } = connect();
    beats.beat(4);
    expect(probes()).toBe(3);
    await expect(client.ready).rejects.toThrow(/stopped answering/);
  });

  test("the heartbeat stops when the connection does", async () => {
    const { server, beats, client } = connect();
    server.greet();
    await client.ready;
    expect(beats.running()).toBe(1);
    client.close();
    expect(beats.running()).toBe(0);
  });

  test("everyMs 0 turns it off", () => {
    const { beats } = connect({ everyMs: 0 });
    expect(beats.running()).toBe(0);
  });

  // The other direction of the asymmetry in wire.ts: a server that probes its
  // client is a server this client does not understand, and a frame arriving
  // from the wrong side is never answered out of politeness.
  test("a server that sends a probe of its own is refused", async () => {
    const { server, client } = connect();
    server.greet();
    await client.ready;
    server.say({ t: "ping" });
    await expect(client.closed).resolves.toBeUndefined();
    expect(server.isClosed()).toBe(true);
  });
});

// The interface is the whole contract between this file and a transport, so a
// duplex that implements it and nothing else has to work. This is what the
// Swift shell will hand over: an object with four members and no lineage.
test("any object shaped like a Duplex will do", async () => {
  let sent: Uint8Array[] = [];
  const bare: Duplex = {
    write: (b) => void sent.push(b),
    close: () => {},
  };
  const client = clientConnection(bare, { push: nowherePush(), build: "0.1.0" });
  expect(sent.length).toBe(1);
  const decoder = new FrameDecoder();
  const [frame] = decoder.push(sent[0]!);
  expect(frame && frame.type === CONTROL_FRAME && parseControl(frame.text).t).toBe("hello");
  sent = [];
  bare.onData?.(encodeControl(hello("server", "0.1.0", "", "one-server")));
  await client.ready;
});
