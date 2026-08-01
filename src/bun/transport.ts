// One connection between a Ledge client and a Ledge server (remote.md §3).
//
// Both ends of the protocol live here, because they are one thing described
// twice: the server dispatches `req` frames into the handler map createServer
// returned and writes its pushes out, and the client writes `req` frames and
// presents the answers as that same handler map. That symmetry is what lets
// bun/index.ts bind either one to Electrobun's RPC without knowing which it
// got, and it is the reason the remote path is not a second implementation.
//
// The transport underneath is a duplex byte stream and nothing more. A local
// server is a child process's pipes; a remote one is `ssh <target>
// ledge-server serve`, which is the same pipes with a longer wire. Neither
// end opens a port.
import {
  binaryPath,
  checkHello,
  encodeBinary,
  encodeControl,
  FrameDecoder,
  hello,
  hoistBinary,
  needsOp,
  parseControl,
  PUSH_MESSAGES,
  REQUEST_METHODS,
  restoreBinary,
  WireError,
  type Frame,
  type Hello,
  type WireMessage,
} from "../shared/wire";
import type { OpLog } from "./opLog";
import type { RequestHandlers, ServerPush } from "./server";

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

/** The server's half: hand `push` to createServer, then `serve` it the
 * handlers it returned. */
export interface ServerConnection {
  push: ServerPush;
  serve(handlers: RequestHandlers): void;
  /** The connected client's id, from its hello (remote.md §5), and "" until
   * one has arrived. A getter rather than a promise because it is always
   * correct at the only time anyone asks: no request is dispatched before the
   * handshake, so any handler reading this already has the answer. */
  client(): string;
  closed: Promise<void>;
  close(why?: string): void;
}

/** The client's half. `requests` is the same shape a local server returns, so
 * everything above it is unchanged by being on another machine. */
export interface ClientConnection {
  requests: RequestHandlers;
  /** One request, with the option of naming its `op` (remote.md §7). The
   * primitive `requests` is built over; reconnectingClient uses it directly,
   * because replaying a request under the SAME op is the whole mechanism. */
  call(method: string, params: unknown, op?: string): Promise<unknown>;
  /** The server's hello, once accepted. Rejects with the refusal when the two
   * ends disagree about the protocol, and when the server dies before saying
   * anything at all. */
  ready: Promise<Hello>;
  closed: Promise<void>;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** Which method this id answers, so a response carrying bytes knows where to
   * put them back. */
  method: string;
}

// --- frames with bytes in them -----------------------------------------------

/**
 * Write one control message, with the payload's bulky base64 field (if it has
 * one) as a binary frame immediately before it.
 *
 * Before, not after, and it matters: the receiver holds at most one waiting
 * binary frame, so "the bytes that just arrived" is the whole correlation
 * story. Sending them afterwards would mean a control frame that references
 * something not yet in hand, which is a state a peer could leave open.
 */
function writeMessage(write: (b: Uint8Array) => void, msg: WireMessage, kind: "req" | "res" | "push", method: string): void {
  const path = binaryPath(kind, method);
  const body = msg.t === "req" ? msg.p : msg.t === "res" ? msg.r : msg.t === "push" ? msg.p : null;
  const hoisted = path && body !== null ? hoistBinary(body, path) : null;
  if (!hoisted) return write(encodeControl(msg));
  const bin = nextBinaryId();
  write(encodeBinary(bin, hoisted.bytes));
  write(
    encodeControl(
      msg.t === "req"
        ? { ...msg, p: hoisted.payload, bin }
        : msg.t === "res"
          ? { ...msg, r: hoisted.payload, bin }
          : { ...(msg as { t: "push"; m: string; p: unknown }), p: hoisted.payload, bin },
    ),
  );
}

// Correlates a binary frame with the control frame behind it and nothing else,
// so it only has to be unique against its immediate neighbour. Wrapped at 32
// bits because the field is a u32 on the wire.
let binaryId = 0;
function nextBinaryId(): number {
  binaryId = (binaryId + 1) >>> 0;
  return binaryId;
}

// Bun on both ends (wire.ts says why the codec can assume it), so Buffer
// rather than a hand-rolled table.
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The receiving side of the same rule: hold the bytes until the next control
 * frame claims them, and refuse a second binary frame before that happens.
 *
 * Refusing is the point. A peer that can queue binary frames can make the
 * other end hold megabytes on the promise of a control frame it never sends,
 * and the cap on one frame does nothing about a thousand of them.
 */
class BinaryHolder {
  private held: { id: number; bytes: Uint8Array } | null = null;

  hold(frame: Extract<Frame, { type: 1 }>): void {
    if (this.held) throw new WireError("the peer sent two binary frames with no control frame between them");
    this.held = { id: frame.id, bytes: frame.bytes };
  }

  /** Put the bytes back into the payload the sender took them from. Also the
   * check that a claimed frame is the one that arrived. */
  claim(msg: WireMessage, kind: "req" | "res" | "push", method: string): unknown {
    const bin = msg.t === "req" || msg.t === "res" || msg.t === "push" ? msg.bin : undefined;
    const body = msg.t === "req" ? msg.p : msg.t === "res" ? msg.r : msg.t === "push" ? msg.p : null;
    // Held bytes are NOT dropped by a message that did not ask for them: that
    // would turn a desync into a silent truncation, and idle() below is what
    // catches it.
    if (bin === undefined) return body;
    const held = this.held;
    this.held = null;
    if (!held || held.id !== bin) throw new WireError("the peer claimed a binary frame that did not arrive");
    const path = binaryPath(kind, method);
    if (!path) throw new WireError(`the peer sent bytes with ${kind}:${method}, which carries none`);
    return restoreBinary(body, path, held.bytes);
  }

  /** A control frame that claimed nothing leaves nothing held: bytes with no
   * claimant are a desync, not a spare. */
  idle(): boolean {
    return this.held === null;
  }
}

// --- the server's end --------------------------------------------------------

export interface ServerOpts {
  build: string;
  /** Which run of the server this is (wire.ts Hello.instance). The daemon
   * mints one per process; a server that dies with its connection leaves this
   * empty, which reads as "never replay to me" and is the truth. */
  instance?: string;
  /** The dedupe window (remote.md §7). Supplied by whoever owns the server
   * ACROSS connections — the daemon — because a window scoped to one
   * connection is forgotten at the moment a replay needs it. Absent means no
   * deduping, which is right for a server that dies with its connection. */
  ops?: OpLog;
  /** Overrides for the output coalescer, for tests that cannot wait 30ms. */
  coalesce?: { ms?: number; bytes?: number };
}

export function serverConnection(duplex: Duplex, opts: ServerOpts): ServerConnection {
  const { build, ops, coalesce, instance = "" } = opts;
  const decoder = new FrameDecoder();
  const incoming = new BinaryHolder();
  let handlers: RequestHandlers | null = null;
  let greeted = false;
  let peerClient = "";
  let open = true;
  // Requests that beat createServer to the door. A server sends its hello
  // immediately (it is a constant, and waiting would make a slow boot look
  // like a dead pipe), so a brisk client can have a request in flight before
  // the vault has finished loading.
  const waiting: Array<{ id: number; m: string; p: unknown; op?: string }> = [];

  let settle!: () => void;
  const closed = new Promise<void>((resolve) => (settle = resolve));

  function raw(bytes: Uint8Array): void {
    try {
      duplex.write(bytes);
    } catch (err) {
      console.error("[wire] could not write to the client:", err);
      close();
    }
  }

  function send(msg: WireMessage, method = ""): void {
    if (!open) return;
    // Everything else flushes the coalescer first. Terminal bytes held back
    // for a few milliseconds must not overtake the terminalAttach response
    // that is supposed to precede them, or the drawer replays its scrollback
    // and then paints output older than the snapshot on top of it.
    if (msg.t !== "push" || msg.m !== "terminalOutput") flushOutput();
    if (msg.t === "res" || msg.t === "push") writeMessage(raw, msg, msg.t, method);
    else raw(encodeControl(msg));
  }

  function close(why?: string): void {
    if (!open) return;
    if (why !== undefined) send({ t: "bye", why });
    open = false;
    stopCoalescing();
    try {
      duplex.close();
    } catch {
      // Already gone. Closing is best-effort by nature.
    }
    settle();
  }

  // --- terminal output, coalesced (remote.md §3) ------------------------------
  //
  // The drain loop pushes whatever a shell produced every 8ms, which is free
  // in-process and 125 frames a second down a wire. This holds them back on a
  // Nagle-shaped rule: the first chunk after a quiet moment goes out at once,
  // so an echoed keystroke is never delayed, and a shell that is producing
  // CONTINUOUSLY is flushed on the interval instead of on every tick.
  //
  // Per session, because two drawers' streams are two streams; concatenated,
  // because xterm.js cares about the byte order and nothing else.
  const COALESCE_MS = coalesce?.ms ?? 30;
  const COALESCE_BYTES = coalesce?.bytes ?? 128 * 1024;
  const held = new Map<string, Uint8Array[]>();
  let heldBytes = 0;
  let lastOutAt = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushOutput(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (held.size === 0) return;
    const batch = [...held];
    held.clear();
    heldBytes = 0;
    lastOutAt = Date.now();
    for (const [sessionId, chunks] of batch) {
      const bytes = chunks.length === 1 ? chunks[0]! : concat(...chunks);
      writeMessage(raw, { t: "push", m: "terminalOutput", p: { sessionId, dataB64: toBase64(bytes) } }, "push", "terminalOutput");
    }
  }

  function stopCoalescing(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    held.clear();
    heldBytes = 0;
  }

  function pushOutput(p: { sessionId: string; dataB64: string }): void {
    if (!open) return;
    const bytes = fromBase64(p.dataB64);
    if (bytes.length === 0) return;
    const chunks = held.get(p.sessionId);
    if (chunks) chunks.push(bytes);
    else held.set(p.sessionId, [bytes]);
    heldBytes += bytes.length;
    const quiet = Date.now() - lastOutAt >= COALESCE_MS;
    if (quiet || heldBytes >= COALESCE_BYTES) return flushOutput();
    if (!flushTimer) flushTimer = setTimeout(flushOutput, COALESCE_MS);
  }

  async function dispatch(id: number, method: string, params: unknown, op: string | undefined): Promise<void> {
    // hasOwn, not `in`: the handler map is an object literal, so anything
    // reached through the prototype (`constructor`, `toString`) is the client
    // trying its luck rather than a method.
    const map = handlers as unknown as Record<string, (p: unknown) => unknown> | null;
    if (!map || !Object.hasOwn(map, method)) {
      send({ t: "err", id, e: `unknown method: ${method}` });
      return;
    }
    try {
      // The op keys the dedupe window (remote.md §7). Scoped by client id as
      // well as by op: the window outlives the connection that filled it, and
      // two clients' counters know nothing about each other.
      const run = async () => map[method]!(params);
      send({ t: "res", id, r: await (ops && op !== undefined ? ops.run(`${peerClient}\u0000${op}`, run) : run()) }, method);
    } catch (err) {
      // The message only. Every guard in notes.ts throws its refusal as text,
      // which is what the view has always shown; a stack would add the
      // server's own paths and nothing a user can act on.
      send({ t: "err", id, e: err instanceof Error ? err.message : String(err) });
    }
  }

  function handle(msg: WireMessage): void {
    if (!greeted) {
      // The handshake is the first frame in each direction (remote.md §11).
      // Anything else first is a client that does not speak this protocol.
      if (msg.t !== "hello") return close(`expected a hello first, got ${msg.t}`);
      const refusal = checkHello(msg, "client");
      if (refusal) {
        console.error(`[wire] refused a client: ${refusal}`);
        return close(refusal);
      }
      greeted = true;
      peerClient = msg.client;
      return;
    }
    switch (msg.t) {
      case "req": {
        const p = incoming.claim(msg, "req", msg.m);
        if (handlers) void dispatch(msg.id, msg.m, p, msg.op);
        else waiting.push({ id: msg.id, m: msg.m, p, ...(msg.op === undefined ? {} : { op: msg.op }) });
        return;
      }
      case "bye":
        return close();
      default:
        // res, err, push and a second hello are all server-to-client or
        // once-only. A client sending one is out of sync, and there is no
        // resynchronizing (wire.ts).
        return close(`a client may not send ${msg.t}`);
    }
  }

  duplex.onData = (chunk) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (err) {
      console.error("[wire]", err instanceof Error ? err.message : err);
      return close(err instanceof WireError ? err.message : "unreadable frame");
    }
    for (const frame of frames) {
      try {
        if (frame.type === 1) {
          incoming.hold(frame);
          continue;
        }
        handle(parseControl(frame.text));
        if (!incoming.idle()) throw new WireError("the peer sent bytes that no control frame claimed");
      } catch (err) {
        console.error("[wire]", err instanceof Error ? err.message : err);
        return close(err instanceof WireError ? err.message : "unreadable message");
      }
    }
  };
  duplex.onClose = () => {
    open = false;
    stopCoalescing();
    settle();
  };

  const push = Object.fromEntries(
    PUSH_MESSAGES.map((m) => [
      m,
      m === "terminalOutput"
        ? (p: unknown) => pushOutput(p as { sessionId: string; dataB64: string })
        : (p: unknown) => send({ t: "push", m, p }, m),
    ]),
  ) as unknown as ServerPush;

  raw(encodeControl(hello("server", build, "", instance)));

  return {
    push,
    serve(next) {
      handlers = next;
      for (const { id, m, p, op } of waiting.splice(0)) void dispatch(id, m, p, op);
    },
    client: () => peerClient,
    closed,
    close,
  };
}

// --- the client's end --------------------------------------------------------

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
  ) as unknown as RequestHandlers;

  raw(encodeControl(hello("client", opts.build, opts.client ?? "")));

  return {
    requests,
    call,
    ready,
    closed,
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
}

const RECONNECT_DELAYS = [250, 500, 1000, 2000, 4000, 8000, 8000, 8000] as const;

export async function reconnectingClient(opts: ReconnectOpts): Promise<ClientConnection> {
  const delays = opts.delaysMs ?? RECONNECT_DELAYS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
      void reconnect();
    });
  }

  async function reconnect(): Promise<void> {
    let wake!: () => void;
    resume = new Promise<void>((r) => (wake = r));
    announce("reconnecting", "The connection dropped. Reconnecting…");
    let last = "the connection dropped";
    for (const delay of delays) {
      await sleep(delay);
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
      announce("live", "");
      wake();
      // Under the SAME op ids. The server answers from its record if it ran
      // them already, and runs them if it did not; either way once.
      for (const held of [...inflight.values()]) issue(held);
      return;
    }
    give(`Lost the connection: ${last}.`, wake);
  }

  // The ladder is over, or a different server answered. Recovery from here is
  // choosing the connection again (interactions.md §4-1), which rebuilds
  // everything from boot: nothing in this module could re-establish a
  // session's state by itself, and pretending otherwise would mean an app that
  // looks connected to sessions that no longer exist.
  function give(detail: string, wake: () => void): void {
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
  ) as unknown as RequestHandlers;

  return {
    requests,
    call: (m, p) => call(m, p),
    ready: Promise.resolve(first),
    closed,
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

// --- the transports ----------------------------------------------------------

/**
 * Wraps an I/O pair as a Duplex whose read loop does not start until someone
 * is listening. Creating a duplex and passing it on is two statements, and a
 * chunk delivered between them would be a frame lost to a race nobody would
 * ever reproduce.
 */
function duplexOver(io: {
  write(bytes: Uint8Array): void;
  close(): void;
  incoming(): ReadableStream<Uint8Array>;
}): Duplex {
  let onData: ((chunk: Uint8Array) => void) | undefined;
  let onClose: (() => void) | undefined;
  let reading = false;

  function read(): void {
    if (reading) return;
    reading = true;
    void (async () => {
      // A reader loop rather than `for await`: Bun iterates a ReadableStream
      // happily, but the DOM lib this repo compiles against does not admit it.
      const reader = io.incoming().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) onData?.(value);
        }
      } catch (err) {
        // A pipe that broke mid-read. The close below is the report; there is
        // nobody else to tell.
        console.error("[wire] the connection dropped:", err);
      }
      onClose?.();
    })();
  }

  return {
    write: (bytes) => io.write(bytes),
    close: () => io.close(),
    get onData() {
      return onData;
    },
    set onData(fn) {
      onData = fn;
      read();
    },
    get onClose() {
      return onClose;
    },
    set onClose(fn) {
      onClose = fn;
    },
  };
}

/**
 * A child process's stdio. This is the whole transport story: `ssh <target>
 * ledge-server serve` for another machine and `ledge-server serve` for this
 * one differ only in the command, which is what keeps the local path from
 * being the tested one and the remote path from being the other one.
 *
 * stderr is inherited, so the server's log lines land on this process's
 * terminal (and, over ssh, on ssh's). stdout is the protocol and carries
 * nothing else.
 */
export function spawnDuplex(cmd: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }): Duplex {
  if (cmd.length === 0) throw new Error("a server command cannot be empty");
  const proc = Bun.spawn({
    cmd: [...cmd],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    // Inherited unless the caller says otherwise: a local server needs the
    // user's PATH and SSH_AUTH_SOCK, and `ssh` needs them more.
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  return duplexOver({
    write(bytes) {
      proc.stdin.write(bytes);
      // FileSink buffers; without the flush a request can sit in this process
      // while both ends wait on each other.
      proc.stdin.flush();
    },
    close() {
      try {
        void proc.stdin.end();
      } catch {
        // Already ended.
      }
      proc.kill();
    },
    incoming: () => proc.stdout,
  });
}

/**
 * A Duplex whose incoming side is fed by hand, for transports that hand you
 * bytes in a callback rather than a stream (a socket).
 *
 * Buffers anything that arrives before `onData` is set, for the same reason
 * duplexOver does not start reading until then: creating a duplex and giving
 * it to a connection is two statements, and a frame lost between them would be
 * a race nobody could reproduce.
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
      if (ended) fn?.();
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

/** This process's own stdin and stdout: what `ledge-server serve` is served
 * over, whether ssh or a parent process is holding the other end. */
export function stdioDuplex(): Duplex {
  return duplexOver({
    write(bytes) {
      process.stdout.write(bytes);
    },
    close() {
      // Nothing to close: the process exiting is how this end hangs up, and
      // the caller owns that decision.
    },
    incoming: () => Bun.stdin.stream(),
  });
}
