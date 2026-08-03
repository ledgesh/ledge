// The client's half of a connection to a Ledge server (remote.md §3).
//
// Nothing in this file touches a runtime API. A connection is a `Duplex` —
// write, close, onData, onClose — and everything above it is the protocol: the
// handshake, the op ids, the reconnect ladder, the requests held across a drop,
// and the difference between a wire that broke and a handler that said no.
//
// That is why this half is here and its sibling is not. bun/transport.ts holds
// what a process can do (a child's pipes, this process's stdio) and what only a
// server has (a handler map to dispatch into). The line between the two is
// exactly the line between what a browser can run and what it cannot, which is
// what lets the iOS client run THIS code in its webview, fed by Swift over the
// bridge, rather than reimplementing it in a second language (ios.md §2).
import {
  BinaryHolder,
  checkHello,
  encodeControl,
  FrameDecoder,
  hello,
  needsOp,
  parseControl,
  PUSH_MESSAGES,
  REQUEST_METHODS,
  WireError,
  writeMessage,
  type Hello,
  type RequestClient,
  type ServerPush,
  type WireMessage,
} from "./wire";

/**
 * A byte stream in both directions. `onData` and `onClose` are set by whichever
 * connection takes ownership; reading does not begin until `onData` is, so a
 * duplex created and handed on cannot drop the peer's first frame.
 */
export interface Duplex {
  write(bytes: Uint8Array): void;
  close(): void;
  onData?: ((chunk: Uint8Array) => void) | undefined;
  onClose?: (() => void) | undefined;
}

/** The client's half. `requests` is the same shape a local server returns, so
 * everything above it is unchanged by being on another machine. */
export interface ClientConnection {
  requests: RequestClient;
  /** One request, with the option of naming its `op` (remote.md §7). The
   * primitive `requests` is built over; reconnectingClient uses it directly,
   * because replaying a request under the SAME op is the whole mechanism. */
  call(method: string, params: unknown, op?: string): Promise<unknown>;
  /** The server's hello, once accepted. Rejects with the refusal when the two
   * ends disagree about the protocol, and when the server dies before saying
   * anything at all. */
  ready: Promise<Hello>;
  closed: Promise<void>;
  /**
   * Why the server said it was hanging up, once `closed` has settled. Null for
   * a wire that simply stopped.
   *
   * A wire cannot say anything, so a reason means the server DECIDED: it gave
   * the session to another client (bun/daemon.ts), it is shutting down, or it
   * refused this client's handshake. Re-dialling a decision is not recovery,
   * which is why this is on the interface rather than folded into the error.
   */
  farewell(): string | null;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** Which method this id answers, so a response carrying bytes knows where to
   * put them back. */
  method: string;
}

// --- one connection ----------------------------------------------------------

export function clientConnection(
  duplex: Duplex,
  opts: { push: ServerPush; build: string; client?: string },
): ClientConnection {
  const decoder = new FrameDecoder();
  const incoming = new BinaryHolder();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let open = true;
  // Why the server hung up, when it said. Without it a refused handshake is
  // indistinguishable from a broken pipe, and the difference is the whole
  // content of the error the user needs to see.
  let farewell: string | null = null;

  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => (settleClosed = resolve));
  let acceptHello!: (h: Hello) => void;
  let refuseHello!: (e: Error) => void;
  const ready = new Promise<Hello>((resolve, reject) => {
    acceptHello = resolve;
    refuseHello = reject;
  });
  // Nothing may await `ready` before someone else does, or an early failure is
  // an unhandled rejection that takes the process down.
  void ready.catch(() => {});

  function raw(bytes: Uint8Array): void {
    if (!open) return;
    try {
      duplex.write(bytes);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function fail(err: Error): void {
    if (!open) return;
    open = false;
    refuseHello(err);
    // Typed, not just worded: reconnectingClient replays what a dropped wire
    // took with it and reports what a handler refused, and telling those apart
    // by matching on a message would be a guess about English.
    const lost = new ConnectionLost(err.message);
    for (const { reject } of pending.values()) reject(lost);
    pending.clear();
    try {
      duplex.close();
    } catch {
      // Already gone.
    }
    settleClosed();
  }

  function handle(msg: WireMessage): void {
    switch (msg.t) {
      case "hello": {
        const refusal = checkHello(msg, "server");
        if (refusal) return fail(new Error(`the server refused this client: ${refusal}`));
        acceptHello(msg);
        return;
      }
      case "res": {
        const waiting = pending.get(msg.id);
        pending.delete(msg.id);
        waiting?.resolve(incoming.claim(msg, "res", waiting.method));
        return;
      }
      case "err": {
        pending.get(msg.id)?.reject(new Error(msg.e));
        pending.delete(msg.id);
        return;
      }
      case "push": {
        // Validated against the schema's own list: a name off it would index
        // the push object with whatever the peer chose. CLIENT_PUSHES are
        // absent from that list on purpose — a server claiming to know the
        // state of the wire it is on the far side of is refused by omission.
        if ((PUSH_MESSAGES as readonly string[]).includes(msg.m)) {
          (opts.push as unknown as Record<string, (p: unknown) => void>)[msg.m]!(incoming.claim(msg, "push", msg.m));
        }
        return;
      }
      case "bye": {
        farewell = msg.why;
        return fail(new Error(msg.why));
      }
      default:
        return fail(new Error(`the server sent ${msg.t}, which only a client sends`));
    }
  }

  duplex.onData = (chunk) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (err) {
      return fail(err instanceof Error ? err : new Error(String(err)));
    }
    for (const frame of frames) {
      try {
        if (frame.type === 1) {
          incoming.hold(frame);
          continue;
        }
        handle(parseControl(frame.text));
        if (!incoming.idle()) throw new WireError("the server sent bytes that no control frame claimed");
      } catch (err) {
        return fail(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };
  duplex.onClose = () => {
    fail(new Error(farewell ?? "the connection to the server closed"));
  };

  async function call(method: string, params: unknown, op?: string): Promise<unknown> {
    // The handshake gates the first call and nothing after it: `ready` is
    // already settled by the time a second request is made, so this costs one
    // microtask, not a round trip (remote.md §12).
    await ready;
    // A call made after this connection died must REJECT, not sit in a pending
    // map nothing will ever answer. It is the same failure a request in flight
    // gets, and reconnectingClient tells them apart from a refusal the same
    // way — which is what lets this one be replayed too.
    if (!open) throw new ConnectionLost(farewell ?? "the connection to the server closed");
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      writeMessage(raw, { t: "req", id, m: method, p: params, ...(op === undefined ? {} : { op }) }, "req", method);
    });
  }

  // Deliberately not a Proxy: a Proxy answers to `then`, so a handler map that
  // reached an `await` would be mistaken for a thenable and never resolve.
  //
  // No op ids here: one connection replays nothing, so nothing needs deduping.
  // reconnectingClient() is what mints them, because it is what re-sends.
  const requests = Object.fromEntries(
    REQUEST_METHODS.map((m) => [m, (p: unknown) => call(m, p)]),
  ) as unknown as RequestClient;

  raw(encodeControl(hello("client", opts.build, opts.client ?? "")));

  return {
    requests,
    call,
    ready,
    closed,
    farewell: () => farewell,
    close: () => fail(new Error("this client closed the connection")),
  };
}

// --- a client that survives the wire dropping --------------------------------

/**
 * A connection that fails when the wire breaks, rather than one that IS the
 * wire. It re-dials on a ladder, replays what was in flight under the same op
 * ids, and holds new requests while it does — so a laptop that slept, a
 * network that moved, or an ssh that timed out costs a pause and not a session.
 *
 * What makes the replay safe rather than reckless is the pair of things phase 4
 * added under it: the op log on the server (bun/opLog.ts), which answers a
 * repeated op from the record instead of running it again, and `instance` in
 * the handshake, which says whether that record still exists. A DIFFERENT
 * server answering means the log is empty and a replay would apply a write
 * twice, so the in-flight requests are failed instead. That case is rare (the
 * daemon has to have died and been restarted between two dials) and it is the
 * one case where guessing is a corrupted note.
 */
export interface ReconnectOpts {
  dial(): Promise<Duplex> | Duplex;
  push: ServerPush;
  build: string;
  client?: string;
  /** Told about every change, for the indicator in the chrome (remote.md §8).
   * Never called with "live" before the FIRST connection: boot failure belongs
   * to the caller, not to a state change. */
  onState?(state: "live" | "reconnecting" | "lost", detail: string): void;
  /** The ladder, in ms. Deliberately shorter in total than the daemon's idle
   * timeout (bun/daemon.ts IDLE_EXIT_MS): giving up after the server has
   * already decided nobody is coming would mean reconnecting to a process that
   * threw the sessions away. */
  delaysMs?: readonly number[];
  sleep?(ms: number): Promise<void>;
  /** The clock the steadiness rule below reads, injectable for the same reason
   * `sleep` is: a test drives both and waits for neither. */
  now?(): number;
}

const RECONNECT_DELAYS = [250, 500, 1000, 2000, 4000, 8000, 8000, 8000] as const;

/**
 * How long a connection has to hold before it has earned a fresh ladder.
 *
 * The ladder ends, which is the only thing that makes it a ladder — but it
 * used to start over on every success, so a connection that died the moment it
 * was made had an unbounded budget one rung at a time. Two clients on one
 * daemon are exactly that shape: the server hands the session to whichever
 * dialled last (bun/daemon.ts), so each displaces the other and neither ever
 * stops, at the cost of an ssh handshake and a process on the server per turn.
 *
 * That particular fight ends before this rule is reached, because a `bye`
 * stops the ladder outright. This is what makes the shape of it impossible
 * whatever the cause: a server that crashes as it boots, an ssh killed with
 * its session, a forced command that exits. Ten seconds is thirty times the
 * observed flap and far below any connection a person would call working, so
 * a link worth keeping resets the ladder every time and a link that is not
 * gets told to the user instead of retried forever.
 */
const STEADY_MS = 10_000;

export async function reconnectingClient(opts: ReconnectOpts): Promise<ClientConnection> {
  const delays = opts.delaysMs ?? RECONNECT_DELAYS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  // Unique to this process, so an op id cannot collide with one the server
  // recorded for a previous run of this same client (the id in the handshake
  // is stable across launches; a counter starting at 1 is not).
  const nonce = crypto.randomUUID().slice(0, 8);
  let nextOp = 1;

  const inflight = new Map<number, Held>();
  let nextHeld = 1;

  let conn = await open();
  const first = await conn.ready;
  let instance = first.instance;
  let state: "live" | "reconnecting" | "lost" = "live";
  let shut = false;
  // Where the ladder is, and when the connection it is climbing towards last
  // stood up. Both live out here because the rule that reads them spans
  // reconnects: one attempt cannot tell a flap from a drop.
  let rung = 0;
  let liveSince = now();
  // Set only by a server that said goodbye, which is what makes it different
  // from every other way a connection ends.
  let goodbye: string | null = null;
  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => (settleClosed = resolve));
  // Resolves whenever the connection is live again, so a request that arrives
  // mid-reconnect waits instead of failing.
  let resume: Promise<void> = Promise.resolve();

  function open(): Promise<ClientConnection> | ClientConnection {
    const dialed = opts.dial();
    const build = (d: Duplex) =>
      clientConnection(d, { push: opts.push, build: opts.build, ...(opts.client === undefined ? {} : { client: opts.client }) });
    return dialed instanceof Promise ? dialed.then(build) : build(dialed);
  }

  function announce(next: typeof state, detail: string): void {
    state = next;
    opts.onState?.(next, detail);
  }

  watch(conn);

  function watch(c: ClientConnection): void {
    void c.closed.then(() => {
      if (shut || c !== conn) return;
      // A server that SAID why it was hanging up decided to; a wire that broke
      // could not have. The ladder exists for the second case only, and running
      // it against the first is not recovery — it is an argument with a server
      // that already answered. Displacement is the one that bites: the daemon
      // serves one client and gives the session to whoever dialled last, so two
      // clients that both re-dialled would kick each other off forever, several
      // times a second, each turn costing an ssh handshake and a process on the
      // server.
      const why = c.farewell();
      if (why !== null) {
        goodbye = why;
        return give(`Disconnected: ${why}.`);
      }
      void reconnect();
    });
  }

  async function reconnect(): Promise<void> {
    let wake!: () => void;
    resume = new Promise<void>((r) => (wake = r));
    announce("reconnecting", "The connection dropped. Reconnecting…");
    // A connection that HELD has earned a fresh ladder; one that died as soon
    // as it was made has not, and climbing from the bottom again is how a
    // bounded retry becomes an unbounded one (STEADY_MS).
    if (now() - liveSince >= STEADY_MS) rung = 0;
    let last = "the connection dropped";
    while (rung < delays.length) {
      await sleep(delays[rung++]!);
      if (shut) return wake();
      let next: ClientConnection;
      try {
        next = await open();
        const peer = await next.ready;
        // The same server, or a different one wearing the same address. Only
        // the first can honour a replay.
        if (instance !== "" && peer.instance !== instance) {
          next.close();
          return give(`${plural(inflight.size)} could not be finished: the server restarted.`, wake);
        }
        instance = peer.instance;
      } catch (err) {
        last = reasonOf(err);
        continue;
      }
      conn = next;
      watch(next);
      liveSince = now();
      announce("live", "");
      wake();
      // Under the SAME op ids. The server answers from its record if it ran
      // them already, and runs them if it did not; either way once.
      for (const held of [...inflight.values()]) issue(held);
      return;
    }
    give(`Lost the connection: ${last}.`, wake);
  }

  // The ladder is over, a different server answered, or the server said
  // goodbye. Recovery from here is choosing the connection again
  // (interactions.md §4-1), which rebuilds everything from boot: nothing in
  // this module could re-establish a session's state by itself, and pretending
  // otherwise would mean an app that looks connected to sessions that no
  // longer exist.
  function give(detail: string, wake: () => void = () => {}): void {
    announce("lost", detail);
    const err = new Error(detail);
    for (const held of inflight.values()) held.reject(err);
    inflight.clear();
    wake();
    settleClosed();
  }

  function issue(held: Held): void {
    const c = conn;
    void c
      .call(held.method, held.params, held.op)
      .then(
        (value) => {
          if (!inflight.delete(held.id)) return;
          held.resolve(value);
        },
        (err: unknown) => {
          // A handler said no: that is an answer, and it is final. Only a
          // TRANSPORT failure is worth replaying, and only that one leaves the
          // request in flight for the next connection to carry.
          if (!(err instanceof ConnectionLost)) {
            if (!inflight.delete(held.id)) return;
            held.reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
  }

  // Through a function so the await below does not read a stale narrowing: the
  // whole point of waiting is that `state` may have moved while we did.
  const gaveUp = (): boolean => state === "lost";

  async function call(method: string, params: unknown): Promise<unknown> {
    if (gaveUp()) throw new Error("There is no connection to the server.");
    await resume;
    if (gaveUp()) throw new Error("There is no connection to the server.");
    // Reads are replayed as themselves; everything else is deduped by op
    // (wire.ts needsOp), which is stated as the reads precisely so a method
    // nobody classified lands on the safe side.
    const op = needsOp(method) ? `${nonce}:${nextOp++}` : undefined;
    return new Promise<unknown>((resolve, reject) => {
      const held: Held = { id: nextHeld++, method, params, resolve, reject, ...(op === undefined ? {} : { op }) };
      inflight.set(held.id, held);
      issue(held);
    });
  }

  const requests = Object.fromEntries(
    REQUEST_METHODS.map((m) => [m, (p: unknown) => call(m, p)]),
  ) as unknown as RequestClient;

  return {
    requests,
    call: (m, p) => call(m, p),
    ready: Promise.resolve(first),
    closed,
    farewell: () => goodbye,
    close() {
      shut = true;
      // Before the connection goes, because the whole point of holding a
      // request in flight is that something will carry it — and after this
      // there is nothing. A deliberate close is not a state change worth
      // announcing: a connection switch closes this one on its way to another.
      const err = new Error("this client closed the connection");
      for (const held of inflight.values()) held.reject(err);
      inflight.clear();
      state = "lost";
      conn.close();
      settleClosed();
    },
  };
}

interface Held {
  id: number;
  method: string;
  params: unknown;
  op?: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** The wire went away, as opposed to a handler saying no. The difference
 * decides whether a request is replayed or reported, so it is a type rather
 * than a string match on a message. */
export class ConnectionLost extends Error {
  override readonly name = "ConnectionLost";
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plural(n: number): string {
  return n === 1 ? "One request" : `${n} requests`;
}

// --- a transport somebody else drives ----------------------------------------

/**
 * A Duplex whose incoming side is fed by hand, for transports that hand you
 * bytes in a callback rather than a stream: a unix socket in Bun, and Swift
 * calling into the webview on iOS (ios.md §2).
 *
 * Buffers anything that arrives before `onData` is set, for the same reason
 * bun/transport.ts's duplexOver does not start reading until then: creating a
 * duplex and giving it to a connection is two statements, and a frame lost
 * between them would be a race nobody could reproduce.
 */
export function fedDuplex(io: { write(bytes: Uint8Array): void; close(): void }): Duplex & {
  feed(chunk: Uint8Array): void;
  finish(): void;
} {
  let onData: ((chunk: Uint8Array) => void) | undefined;
  let onClose: (() => void) | undefined;
  const early: Uint8Array[] = [];
  let ended = false;

  return {
    write: (bytes) => io.write(bytes),
    close: () => io.close(),
    get onData() {
      return onData;
    },
    set onData(fn) {
      onData = fn;
      if (fn) for (const chunk of early.splice(0)) fn(chunk);
      if (ended) onClose?.();
    },
    get onClose() {
      return onClose;
    },
    set onClose(fn) {
      onClose = fn;
      // Only once there is a reader, and for the same reason finish() waits:
      // the close must never overtake bytes still sitting in `early`. A
      // connection attaches onData first and this is moot, but the ORDER a
      // consumer attaches its two callbacks in is not something this interface
      // asks about, so it cannot be load-bearing either.
      if (ended && onData) fn?.();
    },
    feed(chunk) {
      if (onData) onData(chunk);
      else early.push(chunk);
    },
    finish() {
      if (ended) return;
      ended = true;
      // Only once the early bytes have been delivered: a peer that says its
      // piece and hangs up immediately still gets read.
      if (onData) onClose?.();
    },
  };
}
