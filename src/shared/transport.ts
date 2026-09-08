// The client's half of a connection to a Ledge server (remote.md §3).
//
// Nothing in this file touches a runtime API except a timer. A connection is a
// `Duplex` (write, close, onData, onClose), and everything above it is the
// protocol: the handshake, the heartbeat, the op ids, the reconnect ladder, the
// requests held across a drop, and the difference between a wire that broke and
// a handler that said no.
//
// The sibling file bun/transport.ts holds what needs a process: a child's
// pipes, this process's stdio, and the handler map only a server has to
// dispatch into. The line between the two files is the line between what a
// browser can run and what it cannot. So the iOS client runs this file in its
// webview, fed by Swift over the bridge, rather than reimplementing it in a
// second language (ios.md §2).
import {
  BinaryHolder,
  checkHello,
  CLIENT_METHODS,
  declared,
  encodeControl,
  FrameDecoder,
  hello,
  needsOp,
  parseControl,
  PUSH_MESSAGES,
  REQUEST_METHODS,
  WIRE_METHODS,
  WireError,
  writeMessage,
  type Hello,
  type RequestClient,
  type ServerPush,
  type WireMessage,
} from "./wire";

/**
 * A byte stream in both directions. `onData` and `onClose` are set by whichever
 * connection takes ownership. Reading does not begin until `onData` is set, so
 * a duplex created and then handed on cannot drop the peer's first frame.
 */
export interface Duplex {
  write(bytes: Uint8Array): void;
  close(): void;
  onData?: ((chunk: Uint8Array) => void) | undefined;
  onClose?: (() => void) | undefined;
}

/**
 * A server that chose to hang up, and whether that is the end of it.
 *
 * `back` is the server saying it expects to be reachable again (wire.ts
 * `bye`): it is stopping, not refusing this client. A client answers a stop by
 * dialling again in a moment. It answers a refusal by not dialling at all.
 * Nothing under the protocol tells the two apart.
 */
export interface Farewell {
  why: string;
  back: boolean;
}

/** The client's half. `requests` is the same shape a local server returns, so
 * everything above it is unchanged by being on another machine. */
export interface ClientConnection {
  requests: RequestClient;
  /** One request, with the option of naming its `op` (remote.md §7). The
   * primitive `requests` is built over. reconnectingClient calls it directly,
   * so a replay can reuse the op id of the request it is replaying. */
  call(method: string, params: unknown, op?: string): Promise<unknown>;
  /** The server's hello, once accepted. Rejects with the refusal when the two
   * ends disagree about the protocol, and when the server dies before saying
   * anything at all. */
  ready: Promise<Hello>;
  /**
   * Whether this server answers a method (remote.md §11). False only once the
   * server has said what it answers and left this one out. A server that
   * declared nothing counts as supporting everything, the way it behaved
   * before it was asked.
   *
   * Answered from the hello, so it costs nothing and is available before the
   * call: a command that needs a method this server lacks is left out of the
   * palette rather than shown and then failing (interactions.md §8).
   *
   * Always false for a CLIENT_METHOD, whoever is on the far end. The question
   * is what the server answers, and those are answered at home.
   */
  supports(method: string): boolean;
  /**
   * Check the link now, rather than at the next heartbeat tick or the next
   * rung of the ladder.
   *
   * For the callers that learn something the wire cannot: a machine that just
   * woke, an operating system reporting the network back, a user who pressed
   * the button because they can see it is. One connection probes and a
   * reconnecting one dials. It is one verb because the caller does not know
   * which kind of connection it has.
   */
  recheck(): void;
  closed: Promise<void>;
  /**
   * What the server said on its way out, once `closed` has settled. Null for a
   * wire that simply stopped.
   *
   * A wire says nothing, so a reason means the server decided: it gave the
   * session to another client (bun/daemon.ts), it is shutting down, or it
   * refused this client's handshake. Re-dialling a decision the server has not
   * said it will reverse is not recovery, so callers need this on the interface
   * rather than folded into the error. The shutting-down case carries `back`,
   * because that decision undoes itself.
   */
  farewell(): Farewell | null;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** Which method this id answers, so a response carrying bytes knows where to
   * put them back. */
  method: string;
}

// --- the heartbeat -----------------------------------------------------------

/**
 * How long the wire may be quiet before this client asks whether anyone is
 * still on the other end, and how many asks may go unanswered before it calls
 * the connection dead.
 *
 * The two numbers match OpenSSH's `ServerAliveInterval=5` and
 * `ServerAliveCountMax=3` (bun/connections.ts), which answer the same question:
 * the answer should not depend on which client is asking. Twenty seconds is
 * weighed against what each mistake costs (remote.md §7). Hanging up on a link
 * that was only stalled costs a reconnect. Not hanging up costs the session.
 *
 * What this adds over ssh's own probes on the Mac and TCP's on the phone
 * (ios.md §3) is who answers. A TCP keepalive is answered by the nearest TCP
 * peer and a `ServerAlive` by sshd. A pong comes from the process holding the
 * notes, through every hop between here and it, so nothing but the server can
 * answer it. It is in the protocol rather than in a transport, so every client
 * has it.
 */
export const PROBE_EVERY_MS = 5_000;
export const PROBES_ALLOWED = 3;

/** When this client calls a wire that stopped carrying anything dead: the last
 * probe goes out at `PROBE_EVERY_MS * PROBES_ALLOWED`, and the tick after it
 * gives up. Exported because the server measures its own patience against it
 * (bun/transport.ts). */
export const DEAD_AFTER_MS = PROBE_EVERY_MS * (PROBES_ALLOWED + 1);

/**
 * How long a client asks a server to keep its sessions once the client goes
 * away (wire.ts `Hello.hold`). The one number in the protocol the client sets
 * rather than the server. It is sent at connect time because no client gets a
 * moment to send it later: an app iOS suspends says nothing on the way out, and
 * neither does a Mac whose wifi drops or whose lid closes (ios.md §5).
 *
 * Five minutes covers a locked screen, a message answered, and a way back, and
 * stays well under the daemon's ceiling (`HOLD_MAX_MS`), so an ordinary ask is
 * granted whole. Every client asks and not only the phone, because a device
 * that leaves and comes back within a few minutes should find its shells where
 * it left them: remote.md §7 has the cases, and bun/daemon.ts IDLE_EXIT_MS is
 * the timer that takes those shells away.
 */
export const SESSION_HOLD_MS = 5 * 60_000;

export interface HeartbeatOpts {
  /** Quiet for this long and the client probes. 0 turns the heartbeat off
   * entirely, for a test that is not about it. */
  everyMs?: number;
  /** Probes that may go unanswered before the connection is dead. */
  allowed?: number;
  /**
   * The repeating timer, the only runtime API this file's core touches.
   * Injectable for the same reason as `sleep` below: a test drives twenty
   * seconds of silence in a microtask rather than waiting for it. Returns the
   * canceller.
   */
  repeat?(ms: number, tick: () => void): () => void;
  /** The clock the suspension check below reads. Injectable so a test can put
   * an hour between two beats without waiting one. */
  now?(): number;
}

/** The names a client shell answers at home, so they never become a frame
 * (wire.ts CLIENT_METHODS). A set, because `call` checks it on every request. */
const CLIENT_SEAM = new Set<string>(CLIENT_METHODS);

/** The default `repeat`, and the server's too (bun/transport.ts). Both ends
 * need a timer that ticks without holding a process open by itself. */
export function repeatEvery(ms: number, tick: () => void): () => void {
  const id = setInterval(tick, ms);
  // A watchdog is not a reason for a process to stay up. Bun has unref and a
  // webview does not, where there is no process to hold open either.
  (id as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(id);
}

// --- one connection ----------------------------------------------------------

export function clientConnection(
  duplex: Duplex,
  opts: {
    push: ServerPush;
    build: string;
    client?: string;
    label?: string;
    /** The device every window of this client shares, for the vault
     * (`Hello.device`). Omitted means "the same as `client`". */
    device?: string;
    hold?: number;
    heartbeat?: HeartbeatOpts;
  },
): ClientConnection {
  const decoder = new FrameDecoder();
  const incoming = new BinaryHolder();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let open = true;
  // Why the server hung up, when it said. Without it a refused handshake looks
  // the same as a broken pipe, and that difference is what the error has to
  // tell the user.
  let farewell: Farewell | null = null;
  // What killed this connection, whoever decided it. Unlike `farewell` this is
  // set however it died, so a request made a moment too late is told what a
  // request in flight is told. "The connection to the server closed" is what a
  // caller can already see; the heartbeat's verdict is the part it cannot.
  let cause: string | null = null;

  // The heartbeat's state (remote.md §7). Two flags rather than one, because
  // the directions answer different questions: what arrived is how this end
  // knows the server is there, and what left is how the server knows this
  // client is (bun/transport.ts drops one that has gone silent). A wire
  // carrying a build's output is quiet outbound and busy inbound, and a client
  // waiting at a prompt is the reverse.
  const heartbeat = opts.heartbeat ?? {};
  const probeEveryMs = heartbeat.everyMs ?? PROBE_EVERY_MS;
  const probesAllowed = heartbeat.allowed ?? PROBES_ALLOWED;
  const clock = heartbeat.now ?? (() => Date.now());
  let heard = false;
  let sent = false;
  let unanswered = 0;
  let stopProbing: (() => void) | null = null;
  // When the last beat ran. The only clock read in here, and it is read to
  // notice the beats that did not run (see `beat`).
  let beatAt = clock();

  // What the server said it answers, narrowed to names this client knows
  // (wire.ts `declared`). Null until the hello arrives, and null after it for a
  // server that declared nothing. Both mean "no reason to think it cannot", so
  // an older server degrades one call at a time instead of failing at the door.
  let serverMethods: Set<string> | null = null;
  // Whether the server's hello has been accepted. Only the handshake reads it,
  // and only to tell a refusal at the door from a connection that worked and
  // then ended: the first is a verdict about the two builds, the second can be
  // anything at all.
  let greeted = false;

  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => (settleClosed = resolve));
  let acceptHello!: (h: Hello) => void;
  let refuseHello!: (e: Error) => void;
  const ready = new Promise<Hello>((resolve, reject) => {
    acceptHello = resolve;
    refuseHello = reject;
  });
  // A no-op handler, so a failure that lands before any caller awaits `ready`
  // is not an unhandled rejection that takes the process down.
  void ready.catch(() => {});

  function raw(bytes: Uint8Array): void {
    if (!open) return;
    sent = true;
    try {
      duplex.write(bytes);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function fail(err: Error): void {
    if (!open) return;
    open = false;
    cause = err.message;
    stopProbing?.();
    stopProbing = null;
    refuseHello(err);
    // Typed rather than only worded: reconnectingClient replays what a dropped
    // wire took with it and reports what a handler refused, and telling those
    // apart by matching on message text would be a guess about English.
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
        // The refusal as `checkHello` wrote it, with no prefix. It used to be
        // prefixed "the server refused this client", which named the wrong
        // end: this end is doing the refusing, on a hello the server sent
        // without knowing who would read it, and the server may well be
        // accepting this client's hello in the same instant.
        if (refusal) return fail(new Refused(refusal));
        greeted = true;
        serverMethods = declared(msg.methods, WIRE_METHODS);
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
        // the push object with whatever the peer chose. CLIENT_PUSHES is kept
        // out of PUSH_MESSAGES as a separate list (wire.ts), so a server
        // claiming to know the state of the wire it is on the far side of is
        // ignored here. Adding CLIENT_PUSHES to PUSH_MESSAGES would undo that.
        if ((PUSH_MESSAGES as readonly string[]).includes(msg.m)) {
          (opts.push as unknown as Record<string, (p: unknown) => void>)[msg.m]!(incoming.claim(msg, "push", msg.m));
        }
        return;
      }
      case "bye": {
        farewell = { why: msg.why, back: msg.back === true };
        // Before the handshake finishes, a `bye` is the far end refusing this
        // client. The two hellos cross, so a version mismatch is decided at
        // both ends at once and whichever verdict lands first is the one
        // reported. Typing both as `Refused` keeps the message the same
        // sentence either way (bun/index.ts).
        return fail(greeted ? new Error(msg.why) : new Refused(msg.why));
      }
      // Nothing to do. The bytes a pong arrived in already set `heard`, which
      // is a pong's entire content. The case exists so a pong does not fall
      // through to the default and count as a frame sent the wrong way.
      case "pong":
        return;
      default:
        return fail(new Error(`the server sent ${msg.t}, which only a client sends`));
    }
  }

  /**
   * One beat. Sends a probe when the wire has been quiet in either direction,
   * and gives up when enough probes in a row have gone unanswered.
   *
   * `beat` counts ticks instead of reading a clock. That is what makes it safe
   * on a phone. A suspended app's timers do not fire and a backgrounded
   * webview's are throttled, so elapsed time says nothing about whether the
   * wire is dead: a client that woke after ten minutes would call a working
   * connection lost and drop the session it was holding. It gives up only after
   * three probes in a row have gone unanswered.
   */
  function beat(): void {
    // A tick late by more than the whole patience budget did not happen: the
    // machine slept, the app was suspended, the process was stopped. Nothing
    // was counted while it was not running, so the counters describe a wire
    // that stopped existing several hours ago, and that wire is very likely
    // gone: a lid opens onto an ssh whose far end exited and a daemon that
    // idled out (bun/daemon.ts).
    //
    // Reading the clock here does not contradict the tick counting above. It
    // is what makes the tick counting safe: counting ticks is why a wake never
    // declares a connection dead, and rechecking here is why a wake does not
    // spend the next twenty seconds treating the connection as alive either.
    // It asks at once and acts on the answer.
    const at = clock();
    const asleep = at - beatAt > probeEveryMs * (probesAllowed + 1);
    beatAt = at;
    if (asleep) return recheck();
    const quietIn = !heard;
    const quietOut = !sent;
    heard = false;
    if (!quietIn) {
      unanswered = 0;
    } else if (unanswered >= probesAllowed) {
      const apart = probeEveryMs / 1000;
      return fail(new Error(`the server stopped answering: ${probesAllowed} probes ${apart}s apart went unanswered`));
    } else {
      unanswered += 1;
    }
    if (quietIn || quietOut) raw(encodeControl({ t: "ping" }));
    // Cleared after the probe, so this end's own heartbeat is not the traffic
    // that convinces it the wire is busy. Only what the app sends counts as a
    // client with something to say.
    sent = false;
  }

  /**
   * Probe now, and let this one probe be the wire's last chance.
   *
   * The three-probe budget above is for a wire that can be slow without being
   * dead. This is called when that is not the question: something outside just
   * changed (a machine woke, an interface came back, a person pressed the
   * button) and the far end either still has this socket or it does not. A
   * pong over a working link takes milliseconds, so three more rounds of
   * patience only leave the app looking connected for fifteen seconds while it
   * is not. Being wrong costs a reconnect, which reconnectingClient finishes
   * on its own.
   */
  function recheck(): void {
    if (!open) return;
    heard = false;
    unanswered = probesAllowed;
    raw(encodeControl({ t: "ping" }));
    sent = false;
  }

  duplex.onData = (chunk) => {
    // Set on any bytes at all, before anything parses them. A probe asks
    // whether the far end is still there, and half a frame answers that as
    // well as a pong does.
    heard = true;
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
    fail(new Error(farewell?.why ?? "the connection to the server closed"));
  };

  async function call(method: string, params: unknown, op?: string): Promise<unknown> {
    // The handshake gates the first call and nothing after it: `ready` is
    // already settled by the time a second request is made, so this costs one
    // microtask, not a round trip (remote.md §12).
    const peer = await ready;
    // A call made after this connection died rejects rather than sitting in a
    // pending map nothing will ever answer. It fails the way a request in
    // flight fails, so reconnectingClient tells it from a refusal the same way
    // and can replay it too.
    if (!open) throw new ConnectionLost(farewell?.why ?? cause ?? "the connection to the server closed");
    // Two ways a call can be one this server will not answer. They are not the
    // same fact about the world, so they are not the same sentence.
    //
    // The first is a method that is the client's alone (remote.md §10): a
    // clipboard, a window, a connection list. No server has ever answered one
    // and no upgrade will change that, so a call reaching here means the
    // shell's own overlay was not in place, which is a bug in this app rather
    // than a fact about the far end. Worded exactly as bun/server.ts words it,
    // because it is the same refusal, a round trip earlier.
    if (CLIENT_SEAM.has(method)) throw new Error(`${method} is the client's, not the server's (remote.md §10)`);
    // The second is an ordinary method this particular server is too old to
    // have (remote.md §11). This client declined to hang up over a missing
    // method (`serverMethods` above, and `supports`), so it owes the caller the
    // better of the two answers one call at a time. The server would refuse it
    // too (`unknown method:`), but refusing here costs no round trip and names
    // the build and what to do about it.
    if (serverMethods && !serverMethods.has(method)) throw new Unsupported(method, peer.build);
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      writeMessage(raw, { t: "req", id, m: method, p: params, ...(op === undefined ? {} : { op }) }, "req", method);
    });
  }

  // Not a Proxy: a Proxy answers to `then`, so a handler map that reached an
  // `await` would be mistaken for a thenable and never resolve.
  //
  // No op ids here. One connection replays nothing, so nothing needs deduping;
  // reconnectingClient() mints them, because it is what re-sends.
  const requests = Object.fromEntries(
    REQUEST_METHODS.map((m) => [m, (p: unknown) => call(m, p)]),
  ) as unknown as RequestClient;

  raw(encodeControl(hello("client", opts.build, opts.client ?? "", "", opts.hold ?? 0, opts.label ?? "", opts.device ?? "")));
  // Started at the hello rather than at the end of the handshake, which gives
  // the handshake a bound it never had: a server that accepts a connection and
  // then says nothing at all used to leave `ready` pending forever. The ssh
  // `ConnectTimeout` does not cover that, because the dial succeeded.
  if (probeEveryMs > 0) stopProbing = (heartbeat.repeat ?? repeatEvery)(probeEveryMs, beat);

  return {
    requests,
    call,
    ready,
    closed,
    supports: (method: string) =>
      !CLIENT_SEAM.has(method) && (serverMethods === null || serverMethods.has(method)),
    farewell: () => farewell,
    recheck,
    close: () => fail(new Error("this client closed the connection")),
  };
}

// --- a client that survives the wire dropping --------------------------------

/**
 * A connection that outlives the wire, rather than one that is the wire. It
 * re-dials on a ladder, replays what was in flight under the same op ids, and
 * holds new requests while it does, so a laptop that slept, a network that
 * moved, or an ssh that timed out costs a pause and not a session.
 *
 * Two things phase 4 added under it make the replay safe. The server's op log
 * (bun/opLog.ts) answers a repeated op from the record instead of running it
 * again, and `instance` in the handshake says whether that record still
 * exists. A different server answering means the log is empty and a replay
 * would apply a write twice, so the in-flight requests are failed instead.
 * That case is rare: the daemon has to have died and been restarted between
 * two dials, and it is the one case where guessing corrupts a note.
 */
export interface ReconnectOpts {
  dial(): Promise<Duplex> | Duplex;
  push: ServerPush;
  build: string;
  client?: string;
  /** What this device calls itself, for the other clients on the same server
   * (`Hello.label`). A shell with no name to give omits it and shows up as an
   * unnamed device in their chrome rather than as an absent one. */
  label?: string;
  /** The device every window of this client shares, for the vault
   * (`Hello.device`). Omitted means "the same as `client`", which is right for
   * a shell that only ever opens one window. */
  device?: string;
  /**
   * How long to ask the server to keep this client's sessions after the wire
   * ends, in ms. Omitted by a client that does not ask (`Hello.hold`).
   *
   * This and the ladder below answer two different failures. The ladder is for
   * a wire that flaps while the client is running: it notices, and it climbs.
   * A client the operating system suspends runs no timers and notices nothing,
   * while the server it left behind decides on its own clock whether the
   * sessions are still worth a process. Asking up front is what reaches that
   * decision, because a suspended client gets no moment to say anything on the
   * way out (ios.md §5).
   */
  hold?: number;
  /** Told about every change, for the indicator in the chrome (remote.md §8).
   * Never called with "live" before the first connection: a boot failure
   * belongs to the caller, not to a state change. */
  onState?(state: "live" | "reconnecting" | "lost", detail: string): void;
  /** The ladder, in ms. Shorter in total than the daemon's idle timeout
   * (bun/daemon.ts IDLE_EXIT_MS): giving up after the server has already
   * decided nobody is coming would mean reconnecting to a process that threw
   * the sessions away. */
  delaysMs?: readonly number[];
  sleep?(ms: number): Promise<void>;
  /** The clock the steadiness rule below reads, injectable for the same reason
   * `sleep` is: a test drives both and waits for neither. */
  now?(): number;
  /** Passed to every connection this opens. The heartbeat turns a wire that
   * stopped carrying bytes into the `closed` the ladder below acts on, so the
   * two are one mechanism described in two places. */
  heartbeat?: HeartbeatOpts;
  /** How often to dial once the ladder is spent (`RETRY_EVERY_MS`). 0 stops
   * for good instead, for a client that has somewhere else to be: a test that
   * is not about the beat, and a one-shot that would otherwise never exit. */
  retryEveryMs?: number;
}

const RECONNECT_DELAYS = [250, 500, 1000, 2000, 4000, 8000, 8000, 8000] as const;

/**
 * How long a connection has to hold before it has earned a fresh ladder.
 *
 * The ladder used to start over on every success, so a connection that died as
 * soon as it was made had an unbounded budget one rung at a time. The fight
 * that produced this rule (two clients displacing each other on one daemon)
 * now ends earlier, at the `bye` in `watch` below. The rule still blocks that
 * shape whatever the cause: a server that crashes as it boots, an ssh killed
 * with its session, a forced command that exits. Ten seconds sits well below
 * any link a person would call working and well above a flap (remote.md §7 has
 * the measurements).
 */
const STEADY_MS = 10_000;

/**
 * How often to dial once the ladder has run out.
 *
 * The ladder ends after about half a minute, and it is the fast part that ends.
 * The client used to stop for good there, which made every outage longer than
 * that permanent (remote.md §7). Being `lost` still holds while this beats:
 * nothing is in flight, new requests fail at once instead of hanging, and
 * saving is suspended above (notes/store.ts). The one thing that is no longer
 * true is that it is over. The top of the ladder is a change of pace, not a
 * wall.
 *
 * Half a minute is weighed against what each mistake costs. Beating faster pays
 * a TCP handshake to an unanswering host all day for a smaller number. Beating
 * slower makes a lid that opens onto a working network wait, visibly, for
 * nothing. Not much waits on the beat anyway: a machine that just woke rechecks
 * as it wakes, and so does the button (`recheck`).
 */
const RETRY_EVERY_MS = 30_000;

export async function reconnectingClient(opts: ReconnectOpts): Promise<ClientConnection> {
  const delays = opts.delaysMs ?? RECONNECT_DELAYS;
  const sleep = opts.sleep ?? waitFor;
  const now = opts.now ?? (() => Date.now());
  const retryEveryMs = opts.retryEveryMs ?? RETRY_EVERY_MS;
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
  // Where the ladder is, and when the connection it is climbing towards was
  // last live. Both live at this scope because the rule that reads them spans
  // reconnects: one attempt cannot tell a flap from a drop.
  let rung = 0;
  let liveSince = now();
  // Set only by a server whose goodbye was final, which is what separates it
  // from every other way a connection ends. A server that said it is coming
  // back (`back`) also said goodbye and does not set this: it ended one
  // connection, and the ladder below is the answer to that.
  let goodbye: Farewell | null = null;
  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => (settleClosed = resolve));
  // Resolves whenever the connection is live again, so a request that arrives
  // mid-reconnect waits instead of failing.
  let resume: Promise<void> = Promise.resolve();
  // Cuts the beat's sleep short, set only while it is sleeping. `recheck` is
  // the only caller: a machine that woke, an interface that came back, a button
  // that was pressed. Null the rest of the time, so a recheck during the ladder
  // does nothing. The next rung is already seconds away.
  let interrupt: (() => void) | null = null;
  // Whether a recovery is already under way on either path that dials by
  // itself: the ladder climbing, and the beat running or out on a dial.
  // `recheck` reads these to tell a press that brings the next attempt forward
  // from one that would put a second ssh child alongside the first.
  let climbing = false;
  let beating = false;

  function open(): Promise<ClientConnection> | ClientConnection {
    const dialed = opts.dial();
    const build = (d: Duplex) =>
      clientConnection(d, {
        push: opts.push,
        build: opts.build,
        ...(opts.client === undefined ? {} : { client: opts.client }),
        // `label` goes on every dial, like `hold` below. It names the device,
        // and a reconnect that dropped it would leave this client unnamed in
        // everyone else's chrome until the app was restarted.
        ...(opts.label === undefined ? {} : { label: opts.label }),
        // On every dial for `label`'s reason: the device is a fact about this
        // client, not about one connection, and a reconnect that dropped it
        // would ask for the passphrase again on a wire that just came back.
        ...(opts.device === undefined ? {} : { device: opts.device }),
        // `hold` goes on every dial, not only the first. The ask belongs to the
        // client rather than to one connection, and a reconnect that dropped it
        // would hold nothing for the app switch after this one.
        ...(opts.hold === undefined ? {} : { hold: opts.hold }),
        ...(opts.heartbeat === undefined ? {} : { heartbeat: opts.heartbeat }),
      });
    return dialed instanceof Promise ? dialed.then(build) : build(dialed);
  }

  // The last detail announced, so a beat that fails the same way for an hour
  // says it once. The state alone is not enough to dedupe on: a client can sit
  // in `lost` for a long time, and the reason is the part that changes. A host
  // that was unreachable and is now refusing says the network came back.
  let told = "";

  function announce(next: typeof state, detail: string): void {
    if (state === next && told === detail) return;
    state = next;
    told = detail;
    opts.onState?.(next, detail);
  }

  watch(conn);

  function watch(c: ClientConnection): void {
    void c.closed.then(() => {
      if (shut || c !== conn) return;
      // A server that said why it was hanging up chose to; a broken wire did
      // not. The ladder is for the broken wire only. Re-dialling a server that
      // already answered costs the most under displacement. The daemon serves
      // one client and gives the session to whoever dialled last
      // (bun/daemon.ts; remote.md §8). Two clients that both re-dialled would
      // kick each other off forever, several times a second. Each turn costs an
      // ssh handshake and a process on the server.
      //
      // A goodbye marked `back` is the exception. It is about this connection,
      // not about this client: a daemon that is restarting answers the next
      // dial, so the ladder applies to it. Treating `back` as final was how a
      // `systemctl restart`, or the SIGTERM behind a `pkill`, left a window
      // disconnected until someone opened another one.
      const bye = c.farewell();
      if (bye !== null && !bye.back) {
        goodbye = bye;
        return give(`Disconnected: ${bye.why}.`);
      }
      void reconnect(bye?.why);
    });
  }

  /**
   * Climbs the ladder, from wherever it is up to.
   *
   * `said` is the server's own words when it announced the stop. They outrank
   * a guess about the wire in both places a reason is reported. Reporting "the
   * connection dropped" for a server that said it was shutting down sends the
   * user to look at their network for a fault that is not there.
   */
  async function reconnect(said?: string): Promise<void> {
    let wake!: () => void;
    resume = new Promise<void>((r) => (wake = r));
    climbing = true;
    try {
      announce("reconnecting", `${said ? capitalise(said) : "The connection dropped"}. Reconnecting…`);
      // A connection that lasted gets a fresh ladder; one that ended as soon as
      // it was made does not. Starting from the bottom every time turns a
      // bounded retry into an unbounded one (STEADY_MS).
      if (now() - liveSince >= STEADY_MS) rung = 0;
      let last = said ?? "the connection dropped";
      while (rung < delays.length) {
        await sleep(delays[rung++]!);
        if (shut) return wake();
        const why = await attempt(wake);
        if (why === null) return;
        last = why;
      }
      // Out of rungs. The fast part is over and the slow beat starts, with
      // everything about being `lost` true while it runs.
      stall(`Lost the connection: ${last}.`, wake);
    } finally {
      climbing = false;
    }
  }

  /**
   * One dial. Returns null when this client is live again, and the reason it
   * is not otherwise. Everything a ladder rung and a beat have in common.
   */
  async function attempt(wake: () => void): Promise<string | null> {
    let next: ClientConnection;
    let restarted = false;
    try {
      next = await open();
      const peer = await next.ready;
      // The same server, or a different process at the same address. Only the
      // same server can honour a replay: a fresh op log cannot tell a repeat
      // from a first attempt, and guessing there writes a note twice.
      restarted = instance !== "" && peer.instance !== instance;
      instance = peer.instance;
    } catch (err) {
      return reasonOf(err);
    }
    // This client closed while the dial was out. The beat makes that common: a
    // lost client waits half a minute at a time, so a connection switch usually
    // closes it mid-wait. Adopting the connection now would install a live wire
    // on a client that has been shut, against a machine the app has moved off.
    if (shut) {
      next.close();
      return "this client closed the connection";
    }
    conn = next;
    watch(next);
    liveSince = now();
    if (restarted) {
      // A server that restarted kept nothing: not the op log, not the shells,
      // not the runs. It is reconnected to rather than refused, because the
      // daemon idles out a minute after its last client leaves (bun/daemon.ts)
      // and a laptop that slept always wakes to a different process than the
      // one it left (remote.md §7).
      //
      // Announced as a `lost` and then a `live` rather than as a live
      // connection with a footnote, because that pair is what the app above
      // acts on (notes/store.ts holdSaves, editor/bridge.ts reconcileRuns).
      //
      // Only requests carrying an op are failed, on the same line the op log
      // itself is drawn on (wire.ts needsOp). A write replayed into an empty
      // record could apply twice. A read asks about right now, which any server
      // holding the notes can answer, so a note list that was in flight when
      // the daemon turned over simply arrives.
      const doomed = [...inflight.values()].filter((h) => h.op !== undefined);
      if (doomed.length > 0) {
        const err = new Error(`${plural(doomed.length)} could not be finished: the server restarted.`);
        for (const held of doomed) {
          inflight.delete(held.id);
          held.reject(err);
        }
      }
      announce("lost", "The server restarted, so everything it was holding is gone.");
    }
    announce("live", "");
    wake();
    // Reissued under the same op ids. The server answers from its record if it
    // ran them already, and runs them if it did not, so each runs once.
    for (const held of [...inflight.values()]) issue(held);
    return null;
  }

  /**
   * Ends the ladder and starts the beat. Everything a caller can see about
   * being `lost` becomes true: nothing in flight, nothing accepted, saving
   * suspended above. The dialling continues underneath at `RETRY_EVERY_MS`.
   *
   * The state stays `lost` rather than `reconnecting` while the beat runs.
   * Reporting `reconnecting` would sound friendlier and would hang the app. A
   * request made while `reconnecting` waits, and waiting on a wire that dials
   * every half minute is the hang this phase exists to remove.
   */
  function stall(detail: string, wake: () => void = () => {}): void {
    if (retryEveryMs <= 0) return give(detail, wake);
    announce("lost", detail);
    strand(new Error(detail));
    wake();
    void beat(false);
  }

  /**
   * Dials every `retryEveryMs` until this client is live or closed.
   *
   * `soon` starts with the dial instead of with the wait. It is set by a press
   * on a client nothing else was going to dial for, and the press means the
   * wait is unnecessary.
   *
   * One beat at a time. Two would be two ssh children racing to be the one
   * connection, the same waste `recheck` refuses mid-ladder.
   */
  async function beat(soon: boolean): Promise<void> {
    if (beating) return;
    beating = true;
    try {
      let wait = !soon;
      while (!shut && state === "lost") {
        if (wait) {
          await new Promise<void>((resolve) => {
            interrupt = resolve;
            void sleep(retryEveryMs).then(resolve);
          });
          interrupt = null;
        }
        wait = true;
        if (shut || state !== "lost") return;
        const why = await attempt(() => {});
        if (why === null) return;
        announce("lost", `Cannot reach the server: ${why}.`);
        // A client with no beat under it (`retryEveryMs` at 0) gets the one
        // dial the press asked for and no more, rather than a loop with
        // nothing in it to wait on.
        if (retryEveryMs <= 0) return;
      }
    } finally {
      beating = false;
    }
  }

  // Nothing will dial again on its own: the server said a goodbye it did not
  // expect to take back, or no beat is configured. `closed` settles here
  // because it reports that this client stopped. A press on `recheck` can still
  // start it up again, since a person looking at the machine knows something
  // this client does not.
  function give(detail: string, wake: () => void = () => {}): void {
    announce("lost", detail);
    strand(new Error(detail));
    wake();
    settleClosed();
  }

  /** Rejects everything waiting on a wire that will not carry it. A request
   * that hangs forever is indistinguishable from a slow one, which makes a
   * disconnected app look like a working one. */
  function strand(err: Error): void {
    for (const held of inflight.values()) held.reject(err);
    inflight.clear();
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
          // A handler said no, which is an answer and is final. Only a
          // transport failure is replayed, and only it leaves the request in
          // flight for the next connection to carry.
          if (!(err instanceof ConnectionLost)) {
            if (!inflight.delete(held.id)) return;
            held.reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
  }

  // A function so the await below does not read a stale narrowing: `state` may
  // move while the call is waiting.
  const gaveUp = (): boolean => state === "lost";

  async function call(method: string, params: unknown): Promise<unknown> {
    if (gaveUp()) throw new Error("There is no connection to the server.");
    await resume;
    if (gaveUp()) throw new Error("There is no connection to the server.");
    // Reads are replayed as themselves; everything else is deduped by op
    // (wire.ts needsOp). needsOp lists the reads rather than the writes, so a
    // method nobody classified lands on the safe side.
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
    // Asked of the current connection rather than of the one that opened this
    // ladder. A reconnect can land on a different server (`instance` in the
    // handshake is the tell), and that server answers for itself rather than
    // for its predecessor.
    supports: (method: string) => conn.supports(method),
    farewell: () => goodbye,
    // Brings forward whatever this client would do next. A live client probes a
    // wire that may already be dead. A lost client runs its next beat now.
    // Mid-ladder it does nothing: the next rung is seconds away, and a second
    // dial beside it is two ssh children racing to be the one connection.
    recheck() {
      if (shut) return;
      if (state === "live") return conn.recheck();
      // A beat asleep between dials: the next one is now.
      if (interrupt) return interrupt();
      // A ladder mid-climb, or a dial already out on either path. Nothing to
      // bring forward: the next attempt is seconds away, and a second one
      // beside it is two ssh children racing.
      if (climbing || beating) return;
      // Nothing is going to dial at all, which has one cause: a goodbye this
      // client was told was final. It is also the one state in which the
      // chrome's Reconnect used to be a button that did nothing
      // (interactions.md §4-1). The press is not a retry loop: it comes from a
      // person who can see the machine is back, which this client cannot know.
      void beat(true);
    },
    close() {
      shut = true;
      // Held requests are rejected before the connection goes: they are held
      // only because something will carry them, and after this nothing will.
      // The close is not announced as a state change, since a connection
      // switch closes this client on its way to another.
      const err = new Error("this client closed the connection");
      for (const held of inflight.values()) held.reject(err);
      inflight.clear();
      state = "lost";
      // Wakes a sleeping beat so it sees `shut` and stops, instead of dialling
      // a server this client has finished with half a minute from now.
      interrupt?.();
      conn.close();
      settleClosed();
    },
  };
}

/** The default wait, unref'd for the same reason repeatEvery's timer is. A
 * client that is only counting down to its next attempt is not a reason for a
 * process to stay alive, and the beat counts down forever. */
function waitFor(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    (id as unknown as { unref?: () => void }).unref?.();
  });
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

/**
 * The handshake was refused, by either end (remote.md §11).
 *
 * A type rather than a wording, because of who else holds an explanation at
 * that moment. Nearly every way of failing to reach a server happens before the
 * protocol starts, so the caller that dials over ssh keeps ssh's stderr and
 * puts it in front of the transport's account, which for all of those is the
 * useless "the connection to the server closed" (bun/connections.ts
 * `explainDial`). A refused handshake is the one failure on the other side of
 * that line: the far end ran, spoke, and was understood well enough to be
 * disagreed with, and by then stderr holds nothing but the far end's own
 * startup banner. So bun/index.ts rethrows a `Refused` as it stands and skips
 * `explainDial` entirely, which keeps the protocol's own answer rather than a
 * paraphrase made from ssh's leftovers.
 */
export class Refused extends Error {
  override readonly name = "Refused";
}

/**
 * This server does not have the method that was just called (remote.md §11).
 *
 * Not a ConnectionLost: the wire is fine, and replaying this on a reconnect
 * would re-ask a server that has already answered as clearly as it ever will.
 * It is a refusal, and it is reported like any other refusal.
 *
 * It carries the method as a field rather than only in its wording, so a caller
 * that wants to fall back can branch on the name instead of parsing English.
 */
export class Unsupported extends Error {
  override readonly name = "Unsupported";
  constructor(
    readonly method: string,
    build: string,
  ) {
    super(
      `this server has no ${method}: it is running ${build || "an older build"}, which predates it. ` +
        `Upgrading the server adds it; the rest of this connection is unaffected.`,
    );
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plural(n: number): string {
  return n === 1 ? "One request" : `${n} requests`;
}

// Capitalises the server's own words, which open a sentence this end wrote. A
// `bye` arrives lowercase ("this server is shutting down") because it is also
// read mid-sentence, after "Disconnected: ".
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// --- a transport somebody else drives ----------------------------------------

/**
 * A Duplex whose incoming side is fed by hand, for transports that deliver
 * bytes in a callback rather than as a stream: a unix socket in Bun, and Swift
 * calling into the webview on iOS (ios.md §2).
 *
 * Buffers anything that arrives before `onData` is set, for the same reason
 * bun/transport.ts's duplexOver does not start reading until then. Creating a
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
      // The close fires only once there is a reader, for the same reason
      // finish() waits: it must never overtake bytes still sitting in `early`.
      // A connection attaches onData first, so this rarely matters. The
      // interface does not fix the order the two callbacks are attached in, so
      // that order cannot be load-bearing.
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
