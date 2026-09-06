// The client's half on its own, with no import from src/bun: the handshakes
// it refuses, the failures it reports, and fedDuplex, the transport a caller
// drives itself. Bun.listen's data callback drives one today, and Swift
// drives one from the webview on iOS (ios.md §2). The conversation between
// the two ends needs a server, so bun/transport.test.ts covers that instead.
// The imports here are the assertion. Needing `../bun/anything` would mean
// the phase 1 split of ios.md has come undone, and portable.test.ts asserts
// that in the general case.
import { describe, expect, test } from "bun:test";
import {
  clientConnection,
  ConnectionLost,
  fedDuplex,
  Refused,
  Unsupported,
  type Duplex,
  type HeartbeatOpts,
} from "./transport";
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

/** A stand-in server the test drives: it says only what it is told to say,
 * and records what the client said back. */
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

// --- fedDuplex, the duplex a caller drives -----------------------------------

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

  // Buffering exists for this race. Creating a duplex and giving it to a
  // connection takes two statements, and a server greets the moment it is
  // built.
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

  // A peer that speaks and hangs up at once still gets read: the close must
  // not overtake the bytes before it. test.each covers both attach orders. A
  // consumer that sets onClose first would otherwise be told the wire is gone
  // before it hears the last bytes sent on it. The Swift shell is one such
  // consumer, and this file never sees it.
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

  test("a server on another protocol is refused before any request is sent", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet({ protocol: 99, build: "0.9.0" });
    await expect(client.ready).rejects.toThrow(/protocol version 99/);
    await expect(client.requests.vaultState({})).rejects.toThrow(/protocol version 99/);
    // One write, the client's own hello. No request goes out over a
    // connection whose protocol is already in doubt.
    expect(server.writes()).toBe(1);
  });

  // The ssh caller branches on the error type. A version mismatch is the one
  // failure where ssh's stderr holds nothing but the far end's startup
  // banner. Every other failure on the way to a server is explained better by
  // that stderr, so a mismatch is the only one that earns a type of its own
  // (bun/index.ts, bun/connections.ts `explainDial`).
  test("a version mismatch is typed, so ssh's leftovers cannot outrank it", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet({ protocol: 4, build: "0.1.0" });
    await expect(client.ready).rejects.toBeInstanceOf(Refused);
    // Both numbers, the peer's build, and which end to upgrade.
    await expect(client.ready).rejects.toThrow(/protocol version 4 on the server \(build 0\.1\.0\), \d+ here/);
    await expect(client.ready).rejects.toThrow(/Update ledge-server on that machine/);
  });

  test("a server that hangs up before greeting is typed the same way, since the verdict is the same one", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    // The mirror image of the test above: the two hellos cross and the far
    // end decides first. Same disagreement and same sentence, so the caller
    // must not have to tell the two apart.
    server.say({ t: "bye", why: "protocol version 5 on the client (build 0.1.0), 4 here. Update ledge-server on this machine." });
    await expect(client.ready).rejects.toBeInstanceOf(Refused);
  });

  test("a connection that greeted and later ended is NOT a refusal", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet();
    await client.ready;
    server.say({ t: "bye", why: "another client took this session" });
    // ssh's account of a wire that dropped mid-session is worth having. Only
    // the handshake's verdict outranks it.
    await expect(client.closed).resolves.toBeUndefined();
    expect(client.farewell()).toEqual({ why: "another client took this session", back: false });
  });

  // Not a hang. A request made on a connection that is already gone has to
  // reject, or the app waits on a promise nothing will settle.
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

// --- a server that knows fewer methods than this client (remote.md §11) -------
//
// The half of compatibility the handshake no longer refuses over. A connection
// to an older server has to work, minus the calls that server has never heard
// of. Those calls have to fail in a way a caller can act on.

describe("a server that does not have every method", () => {
  const without = (...gone: string[]) => ({
    methods: hello("server", "0.1.0").methods.filter((m) => !gone.includes(m)),
  });

  test("the connection is made, not refused", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet(without("vaultUnlock", "noteLock"));
    await expect(client.ready).resolves.toMatchObject({ role: "server" });
  });

  test("everything it does have still works", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet(without("vaultUnlock"));
    const pending = client.requests.noteRead({ path: "/notes/a.md" });
    await settle();
    const req = server.heard.at(-1) as { id: number };
    server.say({ t: "res", id: req.id, r: { note: { text: "hi", mtimeMs: 1 } } });
    expect(await pending).toEqual({ note: { text: "hi", mtimeMs: 1 } });
  });

  test("the one it lacks fails locally, naming itself and the build to upgrade", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet({ ...without("vaultUnlock"), build: "0.0.9" });
    await client.ready;
    const before = server.writes();
    await expect(client.requests.vaultUnlock({ passphrase: "x" })).rejects.toThrow(/vaultUnlock/);
    await expect(client.requests.vaultUnlock({ passphrase: "x" })).rejects.toThrow(/0\.0\.9/);
    // Refused locally, so the request never left: no round trip to be told
    // what the handshake already said.
    expect(server.writes()).toBe(before);
  });

  // Not a ConnectionLost, or reconnectingClient would replay it forever against
  // a server whose answer will never change.
  test("the failure is a refusal, not a lost wire", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet(without("vaultUnlock"));
    await client.ready;
    const err = await client.requests.vaultUnlock({ passphrase: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unsupported);
    expect(err).not.toBeInstanceOf(ConnectionLost);
    expect((err as Unsupported).method).toBe("vaultUnlock");
  });

  // The palette asks this before it offers a command (interactions.md §8). It
  // leaves out a verb the client cannot run rather than offering one that
  // fails when picked.
  test("a caller can ask before it calls", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet(without("vaultUnlock"));
    await client.ready;
    expect(client.supports("noteRead")).toBe(true);
    expect(client.supports("vaultUnlock")).toBe(false);
  });

  // A server that predates the field declares nothing, which is not the same
  // as declaring no support. It gets the behavior it had before the field
  // existed: the call goes out and the server answers for itself.
  test("a server that declares nothing is assumed to do everything", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet({ methods: [], pushes: [] });
    await client.ready;
    expect(client.supports("vaultUnlock")).toBe(true);
    const pending = client.requests.vaultUnlock({ passphrase: "x" });
    await settle();
    expect(server.heard.at(-1)).toMatchObject({ t: "req", m: "vaultUnlock" });
    server.say({ t: "res", id: (server.heard.at(-1) as { id: number }).id, r: { state: "open" } });
    await pending;
  });

  // Two refusals that must not read as one. "This server is too old" invites
  // an upgrade, but a VPS has no desktop, so no server version will ever
  // serve the clipboard (remote.md §10). An upgrade message would send the
  // user after a fix that does not exist.
  test("a method that is the client's own is refused as that, not as an old server", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet();
    await client.ready;
    await expect(client.requests.clipboardRead({})).rejects.toThrow("remote.md §10");
    await expect(client.requests.clipboardRead({})).rejects.not.toThrow(/upgrad/i);
    expect(client.supports("clipboardRead")).toBe(false);
  });

  // A name the server declares that this client has never heard of falls
  // outside the intersection. Asking about it returns false, not an error.
  test("a name only the server knows is not something this client can call", async () => {
    const server = peer();
    const client = clientConnection(server.duplex, { push: nowherePush(), build: "0.1.0" });
    server.greet({ methods: [...hello("server", "0.1.0").methods, "shippedNextYear"] });
    await client.ready;
    expect(client.supports("shippedNextYear")).toBe(false);
    expect(client.supports("noteRead")).toBe(true);
  });
});

// --- the heartbeat (remote.md §7) ---------------------------------------------

/** The heartbeat's timer, driven by hand. Twenty seconds of silence costs one
 * function call here, so no test below waits for a real clock. That is why the
 * timer is injectable. */
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
    /** How many timers are live. Cancelling a timer lowers this count. */
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
  // has just heard the server's hello and sent its own, so it asks nothing.
  // Beats 2, 3 and 4 each send a probe, and none of the three is answered.
  // Beat 5 gives up.
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

    // Both ways a request can meet the verdict: one already in the pending
    // map when it lands, and one that reaches `call` a moment after. Each
    // rejection has to name the silence. Without it the app announces a
    // closed connection, and nothing ever closed the wire.
    const inFlight = client.requests.vaultState({});
    await settle();
    beats.beat();
    expect(server.isClosed()).toBe(true);
    await expect(inFlight).rejects.toThrow(/stopped answering/);
    await expect(client.requests.vaultState({})).rejects.toThrow(/stopped answering/);
    await client.closed;
  });

  // A closed lid, seen from this test. The timer did not fire for an hour, so
  // nothing was counted and the counters describe an unwatched wire that is
  // very likely gone. Counting ticks is why a wake never declares a connection
  // dead. Since it declared nothing, the client probes at once instead of
  // looking connected to a dead ssh for twenty seconds (remote.md §7).
  test("a client that was suspended asks at once, rather than counting to twenty", async () => {
    let clock = 0;
    const { server, beats, client, probes } = connect({ now: () => clock });
    server.greet();
    await client.ready;

    clock += 60 * 60_000; // a lid, closed
    beats.beat();
    expect(probes()).toBe(1);
    expect(server.isClosed()).toBe(false);

    // That one probe is the whole budget: the question after a wake is not
    // whether the wire is slow. One more silence ends it, five seconds after
    // waking rather than twenty.
    clock += 5_000;
    beats.beat();
    expect(server.isClosed()).toBe(true);
    await expect(client.requests.vaultState({})).rejects.toThrow(/stopped answering/);
  });

  test("and a wire that survived the sleep costs nothing but the asking", async () => {
    let clock = 0;
    const { server, beats, client } = connect({ now: () => clock });
    server.greet();
    await client.ready;

    clock += 60 * 60_000;
    beats.beat();
    server.say({ t: "pong" });

    // A pong after the gap restores the whole budget, like any other answer.
    clock += 5_000;
    beats.beat(4);
    expect(server.isClosed()).toBe(false);
  });

  // The suspend rule compares the clock between one beat and the next, so
  // this test injects `now`. Only a gap longer than the whole budget counts
  // as a suspension. A client left running for a week beats on schedule the
  // whole way, so every gap stays one interval. It must never read its own
  // uptime as a suspension.
  test("a beat that arrives on time is never mistaken for one that did not", async () => {
    let clock = 0;
    const { server, beats, client, probes } = connect({ now: () => clock });
    server.greet();
    await client.ready;
    for (let i = 0; i < 5; i++) {
      clock += 5_000;
      beats.beat();
    }
    // The ordinary five-beat trace from the top of this describe, unchanged.
    // A beat mistaken for a suspension would have spent the budget in two.
    expect(probes()).toBe(3);
    expect(server.isClosed()).toBe(true);
  });

  test("an answer buys the whole budget again", async () => {
    const { server, beats, client, probes } = connect();
    server.greet();
    await client.ready;
    beats.beat(2);
    expect(probes()).toBe(1);
    server.say({ t: "pong" });
    // Four more beats: three fresh probes, then the beat that would have
    // closed the connection had that pong counted for nothing. Three beats
    // here would survive either way and prove nothing.
    beats.beat(4);
    expect(server.isClosed()).toBe(false);
    beats.beat();
    expect(server.isClosed()).toBe(true);
  });

  // This rule exists for the far end. The server hangs up on a connection
  // that stays silent for too long (bun/transport.ts silentMs). A client
  // watching build output hears constantly, but without this rule it would
  // send nothing for the length of the build.
  test("a client that is only listening still speaks", async () => {
    const { server, beats, client, probes } = connect();
    server.greet();
    await client.ready;
    for (let i = 0; i < 5; i++) {
      server.say({ t: "pong" });
      beats.beat();
    }
    // One probe on every beat but the first, which still counts this client's
    // own hello as having spoken.
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

  // A bound the handshake did not have. `ConnectTimeout` covers a dial that
  // does not land. A server that accepts the connection and then says nothing
  // used to leave `ready` pending for as long as the app was open.
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

  // The other direction of the asymmetry in wire.ts: only a client probes. A
  // ping from the server is a frame from the wrong side, so the client closes
  // the connection rather than answering it.
  test("a server that sends a probe of its own is refused", async () => {
    const { server, client } = connect();
    server.greet();
    await client.ready;
    server.say({ t: "ping" });
    await expect(client.closed).resolves.toBeUndefined();
    expect(server.isClosed()).toBe(true);
  });
});

// The Duplex interface is the whole contract between the client and a
// transport, so an object that implements it and nothing else has to work.
// That is what the Swift shell hands over: four members and no base class.
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
