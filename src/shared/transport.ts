// The client's half of a connection to a Ledge server (remote.md §3).
//
// Nothing in this file touches a runtime API except a timer. A connection is a
// `Duplex` — write, close, onData, onClose — and everything above it is the
// protocol: the handshake, the heartbeat, the op ids, the reconnect ladder, the
// requests held across a drop, and the difference between a wire that broke and
// a handler that said no.
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
  /**
   * Whether this server answers a method (remote.md §11). False only once the
   * server has SAID what it answers and left this one out; a server that
   * declared nothing supports everything as far as anyone here knows, which is
   * how it behaved before it was asked.
   *
   * Answered from the hello, so it costs nothing and is available before the
   * call. That is what it is for: a command that needs a method this server
   * lacks should be absent from the palette, not present and then apologetic
   * (interactions.md §8).
   *
   * Always false for a CLIENT_METHOD, whoever is on the far end. The question
   * is what the SERVER answers, and those are answered at home.
   */
  supports(method: string): boolean;
  /**
   * Ask about the link right now, rather than at whatever this connection's own
   * next moment would have been.
   *
   * For the callers that learn something the wire cannot: a machine that just
   * woke, an operating system saying the network is back, a user who pressed
   * the button because they can see it is. What it means depends on where the
   * link is — one connection probes, a reconnecting one dials — and that is the
   * point of it being one verb: none of those callers knows which.
   */
  recheck(): void;
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

// --- the heartbeat -----------------------------------------------------------

/**
 * How long the wire may be quiet before this client asks whether anyone is
 * still on the other end, and how many of those asks may go unanswered before
 * it says the connection is dead.
 *
 * The two numbers are OpenSSH's `ServerAliveInterval=5` and
 * `ServerAliveCountMax=3` (bun/connections.ts) because they are answers to the
 * same question, and the answer should not depend on which client is asking.
 * Twenty seconds is chosen against what each mistake costs (remote.md §7):
 * hanging up on a link that was only stalled costs a reconnect, and not
 * hanging up costs the session.
 *
 * What this buys over the two mechanisms already under it — ssh's own probes
 * on the Mac, TCP's on the phone (ios.md §3) — is WHO ANSWERS. A TCP keepalive
 * is answered by the nearest TCP peer and a `ServerAlive` by sshd; a pong comes
 * from the process holding the notes, through every hop between here and it. So
 * this is the only one of the three that cannot be answered on the server's
 * behalf by something that is not the server, and it is the only one that
 * ships to every client, because it is in the protocol rather than in a
 * transport.
 */
export const PROBE_EVERY_MS = 5_000;
export const PROBES_ALLOWED = 3;

/** When a wire that stopped carrying anything is declared dead: the last probe
 * is sent at `PROBE_EVERY_MS * PROBES_ALLOWED`, and the tick after it is the
 * one that gives up. Exported because the server's own patience is measured
 * against it (bun/transport.ts). */
export const DEAD_AFTER_MS = PROBE_EVERY_MS * (PROBES_ALLOWED + 1);

/**
 * How long a client asks a server to keep its sessions once it goes away
 * (wire.ts `Hello.hold`), and the one number in the protocol that is a
 * client's rather than a server's.
 *
 * Stated at connect time because the moment it is for is a moment nobody gets:
 * an iOS app is suspended shortly after it leaves the foreground and killed for
 * memory without warning (ios.md §5), and a Mac whose wifi drops or whose lid
 * closes says nothing on the way out either. So this says what should happen
 * when this connection ends by ANY means, before it has ended by any of them.
 *
 * Every client, not just the phone. The reasoning that put it on the phone
 * first — a device that leaves and comes back within a few minutes should find
 * its shells where it left them — describes a laptop in a lift, on hotel wifi,
 * or asleep in a bag just as exactly, and a Mac that asked for nothing lost its
 * shells the moment the daemon's idle timer fired (bun/daemon.ts IDLE_EXIT_MS)
 * however briefly it had been away.
 *
 * Five minutes is what a locked screen, a message answered and a way back costs.
 * It is deliberately far short of the daemon's ceiling (`HOLD_MAX_MS`), which is
 * there for a client asking something absurd rather than for this one: the
 * ordinary client should be granted what it asks for whole, and a number that
 * always came back clamped would teach nobody anything when it did.
 */
export const SESSION_HOLD_MS = 5 * 60_000;

export interface HeartbeatOpts {
  /** Quiet for this long and the client probes. 0 turns the heartbeat off
   * entirely, which is for a test that is not about it. */
  everyMs?: number;
  /** Probes that may go unanswered before the connection is dead. */
  allowed?: number;
  /**
   * The repeating timer. The only runtime API this file's core touches, and
   * injectable for the same reason `sleep` is below: a test drives twenty
   * seconds of silence in a microtask rather than waiting for it. Returns the
   * canceller.
   */
  repeat?(ms: number, tick: () => void): () => void;
  /** The clock the suspension check below reads. Injectable so a test can put
   * an hour between two beats without waiting one. */
  now?(): number;
}

/** The names a client shell answers at home, which therefore never become a
 * frame (wire.ts CLIENT_METHODS). A set, because `call` asks on every request. */
const CLIENT_SEAM = new Set<string>(CLIENT_METHODS);

/** The default `repeat`, and the server's too (bun/transport.ts): both ends
 * want a timer that ticks and never holds a process open by itself. */
export function repeatEvery(ms: number, tick: () => void): () => void {
  const id = setInterval(tick, ms);
  // A watchdog is never a reason for a process to stay up. Bun has this and a
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
    hold?: number;
    heartbeat?: HeartbeatOpts;
  },
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
  // What killed this connection, whoever decided it. Unlike `farewell` this is
  // set however it died, and it exists so that a request made a moment too late
  // is told the same thing a request that was in flight is told: "the
  // connection to the server closed" is what a caller can already see, and the
  // heartbeat's verdict is the part it cannot.
  let cause: string | null = null;

  // The heartbeat's state (remote.md §7). Two flags rather than one, because
  // the two directions are asked about for different reasons: what ARRIVED is
  // how this end knows the server is there, and what LEFT is how the server
  // knows this client is (bun/transport.ts drops one that has gone silent).
  // A wire carrying a build's output is quiet outbound and busy inbound, and a
  // client waiting at a prompt is the reverse.
  const heartbeat = opts.heartbeat ?? {};
  const probeEveryMs = heartbeat.everyMs ?? PROBE_EVERY_MS;
  const probesAllowed = heartbeat.allowed ?? PROBES_ALLOWED;
  const clock = heartbeat.now ?? (() => Date.now());
  let heard = false;
  let sent = false;
  let unanswered = 0;
  let stopProbing: (() => void) | null = null;
  // When the last beat ran, which is the only thing in here that reads a clock
  // — and it reads it to notice the beats that DID NOT run (see `beat`).
  let beatAt = clock();

  // What the server said it answers, narrowed to names this client knows
  // (wire.ts `declared`). Null until the hello arrives, and null after it for a
  // server that declared nothing — both mean "no reason to think it cannot",
  // which is what makes an older server degrade one call at a time instead of
  // failing at the door.
  let serverMethods: Set<string> | null = null;
  // Whether the server's hello has been accepted. Only the handshake reads it,
  // and only to tell a refusal at the door from a connection that worked and
  // later ended: the first is a verdict about the two builds, the second is
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
  // Nothing may await `ready` before someone else does, or an early failure is
  // an unhandled rejection that takes the process down.
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
        // The refusal as it was written, with nothing in front of it. It used
        // to be prefixed "the server refused this client", which named the
        // wrong end: this is THIS end refusing, on a hello the server sent
        // without knowing who would read it, and the server may well accept
        // ours in the same instant.
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
        // Before the handshake finished, a `bye` is the far end refusing this
        // one: the two hellos cross, so a version mismatch is decided at both
        // ends at once and whichever verdict lands first is the one reported.
        // Typing both of them the same way is what keeps the message the same
        // sentence either way (bun/index.ts).
        return fail(greeted ? new Error(msg.why) : new Refused(msg.why));
      }
      // Nothing to do with it. `heard` below was set by the bytes it arrived
      // in, and that is the entire content of a pong; the case exists so that
      // one is not mistaken for a frame sent in the wrong direction.
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
   * Counting TICKS rather than reading a clock is deliberate, and it is what
   * makes this safe on a phone. A suspended app's timers do not fire and a
   * backgrounded webview's are throttled, so elapsed time says nothing about
   * whether the wire is dead — a client that woke after ten minutes would
   * declare a perfectly good connection lost and drop the session it was
   * holding. This never gives up on a connection it has not ASKED, three times,
   * and been ignored.
   */
  function beat(): void {
    // A tick that is late by more than the whole patience budget did not
    // happen: the machine slept, the app was suspended, the process was
    // stopped. Nothing was counted while it did not run, so the counters are
    // about a wire that stopped existing several hours ago, and the wire itself
    // is very likely gone — a lid opens onto an ssh whose far end exited and a
    // daemon that idled out (bun/daemon.ts).
    //
    // This does not contradict the tick-counting above it, it is what makes it
    // safe. Counting ticks is why a wake never DECLARES a connection dead; this
    // is why it does not spend the next twenty seconds pretending it is alive
    // either. It asks, immediately, and acts on the answer.
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
    // After the probe, so this end's own heartbeat is not the traffic that
    // convinces it the wire is busy. Only what the APP sends counts as a
    // client with something to say.
    sent = false;
  }

  /**
   * Probe now, and let this one probe be the wire's last chance.
   *
   * The budget above is three probes because a wire can be slow without being
   * dead. This is asked at moments when that is not the question: something
   * outside just changed — a machine woke, an interface came back, a person
   * pressed the button — and the far end either still has this socket or it
   * does not. A pong over any working link is milliseconds; three rounds of
   * patience buys nothing here and costs fifteen seconds of an app that looks
   * connected and is not.
   *
   * Being wrong costs a reconnect, and a reconnect is now a thing that finishes
   * by itself (reconnectingClient).
   */
  function recheck(): void {
    if (!open) return;
    heard = false;
    unanswered = probesAllowed;
    raw(encodeControl({ t: "ping" }));
    sent = false;
  }

  duplex.onData = (chunk) => {
    // Any bytes at all, before anything tries to parse them: what a probe asks
    // is whether the far end is still there, and half a frame answers that as
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
    fail(new Error(farewell ?? "the connection to the server closed"));
  };

  async function call(method: string, params: unknown, op?: string): Promise<unknown> {
    // The handshake gates the first call and nothing after it: `ready` is
    // already settled by the time a second request is made, so this costs one
    // microtask, not a round trip (remote.md §12).
    const peer = await ready;
    // A call made after this connection died must REJECT, not sit in a pending
    // map nothing will ever answer. It is the same failure a request in flight
    // gets, and reconnectingClient tells them apart from a refusal the same
    // way — which is what lets this one be replayed too.
    if (!open) throw new ConnectionLost(farewell ?? cause ?? "the connection to the server closed");
    // Two ways a call can be one this server will not answer, and they are not
    // the same fact about the world, so they must not be the same sentence.
    //
    // The first is a method that is nobody's business but the client's
    // (remote.md §10) — a clipboard, a window, a connection list. No server has
    // ever answered one and no upgrade will change that; a call reaching here
    // means the shell's own overlay was not in place, which is a bug in this
    // app and not a fact about the far end. Worded exactly as bun/server.ts
    // words it, because it is the same refusal arriving a round trip earlier.
    if (CLIENT_SEAM.has(method)) throw new Error(`${method} is the client's, not the server's (remote.md §10)`);
    // The second is an ordinary method this particular server is too old to
    // have (remote.md §11). Refused here rather than on the server, though the
    // server would refuse it too (`unknown method:`): having declined to hang
    // up over it, we owe the caller the better of the two answers — no round
    // trip, and a message that names the build and says what to do about it.
    if (serverMethods && !serverMethods.has(method)) throw new Unsupported(method, peer.build);
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

  raw(encodeControl(hello("client", opts.build, opts.client ?? "", "", opts.hold ?? 0, opts.label ?? "")));
  // From the hello rather than from the handshake, which gives the handshake a
  // bound it never had: a server that accepts a connection and then says
  // nothing at all used to leave `ready` pending forever, and the ssh
  // `ConnectTimeout` does not cover it because the dial succeeded.
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
  /** What this device calls itself, for the other clients on the same server
   * (`Hello.label`). Omitted by a shell that has no name to give, which is then
   * an unnamed device in their chrome rather than an absent one. */
  label?: string;
  /**
   * How long to ask the server to keep this client's sessions after the wire
   * ends, in ms; omitted by a client that does not ask (`Hello.hold`).
   *
   * The ladder below and this are answers to two different failures. The ladder
   * is for a wire that flaps while the client is running: it notices, and it
   * climbs. A client the operating system SUSPENDS runs no timers at all, so it
   * cannot notice anything — and the server it left behind decides on its own
   * clock whether the sessions are still worth a process. Stating the ask up
   * front is what reaches that decision, because a suspended client is not
   * given a moment to say anything on the way out (ios.md §5).
   */
  hold?: number;
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
  /** Passed to every connection this opens. The heartbeat is what turns a wire
   * that stopped carrying bytes into a `closed` the ladder below can act on, so
   * the two are one mechanism described in two places. */
  heartbeat?: HeartbeatOpts;
  /** How often to dial once the ladder is spent (`RETRY_EVERY_MS`). 0 stops
   * for good instead, which is for a client that has somewhere else to be: a
   * test that is not about the beat, and a one-shot that would otherwise never
   * exit. */
  retryEveryMs?: number;
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

/**
 * How often to dial once the ladder has run out.
 *
 * The ladder ends after about half a minute, and what it ends is the FAST part:
 * a wire that flapped is back within a rung or two, and climbing at that rate
 * forever would spend an ssh handshake every few seconds on a laptop in a bag.
 * What used to happen at the top of it was that the client stopped for good,
 * which made every outage longer than thirty seconds permanent — a closed lid,
 * a flight, a hotel with a captive portal — and left the app in a state only a
 * human could get it out of, by finding the chrome and choosing the same server
 * again.
 *
 * So the ladder is a change of pace rather than a wall. Everything about being
 * `lost` still holds while this beats: nothing is in flight, new requests fail
 * at once instead of hanging, and saving is suspended above (notes/store.ts).
 * The one thing that is no longer true is that it is over.
 *
 * Half a minute, against what each half of the mistake costs. A dial that finds
 * nothing is a TCP handshake to a host that does not answer, so beating faster
 * buys a smaller number and pays for it all day; beating slower means a lid
 * that opens onto a working network waits, visibly, for nothing. It is also
 * rarely what anyone waits on: a machine that just woke rechecks the moment it
 * wakes, and so does a button (`recheck`).
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
  // Cuts the beat's sleep short, set only while it is sleeping. `recheck` is
  // the only caller: a machine that woke, an interface that came back, a button
  // that was pressed. Null the rest of the time, which is what makes a recheck
  // during the ladder the no-op it should be — something is already happening,
  // and it is happening within seconds.
  let interrupt: (() => void) | null = null;

  function open(): Promise<ClientConnection> | ClientConnection {
    const dialed = opts.dial();
    const build = (d: Duplex) =>
      clientConnection(d, {
        push: opts.push,
        build: opts.build,
        ...(opts.client === undefined ? {} : { client: opts.client }),
        // Every dial for the same reason the hold is: this names the DEVICE,
        // and a reconnect that dropped it would leave this client unnamed in
        // everyone else's chrome until the app was restarted.
        ...(opts.label === undefined ? {} : { label: opts.label }),
        // Every dial, not only the first: the ask is a property of the client
        // rather than of one connection, and a reconnect that dropped it would
        // hold nothing for the app switch after this one.
        ...(opts.hold === undefined ? {} : { hold: opts.hold }),
        ...(opts.heartbeat === undefined ? {} : { heartbeat: opts.heartbeat }),
      });
    return dialed instanceof Promise ? dialed.then(build) : build(dialed);
  }

  // The last thing said, so a beat that fails the same way for an hour says it
  // once. The state alone is not enough to dedupe on: `lost` is now a state a
  // client can sit in for a long time, and the REASON it is in it is the part
  // that changes and is worth hearing (a host that was unreachable and is now
  // refusing has told you your network came back).
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
      const why = await attempt(wake);
      if (why === null) return;
      last = why;
    }
    // Out of rungs, not out of hope: the fast part is over and the slow one
    // starts, with everything about being `lost` true in between.
    stall(`Lost the connection: ${last}.`, wake);
  }

  /**
   * One dial: null when this client is live again, and the reason it is not
   * otherwise. The whole of what a rung and a beat have in common.
   */
  async function attempt(wake: () => void): Promise<string | null> {
    let next: ClientConnection;
    let restarted = false;
    try {
      next = await open();
      const peer = await next.ready;
      // The same server, or a different process wearing the same address. Only
      // the first can honour a replay: a fresh op log cannot tell a repeat from
      // a first attempt, and guessing there is a note written twice.
      restarted = instance !== "" && peer.instance !== instance;
      instance = peer.instance;
    } catch (err) {
      return reasonOf(err);
    }
    // Closed while this dial was out, which a beat makes ordinary rather than
    // exotic: a lost client sits in one for half a minute at a time, and a
    // connection switch closes it from under whatever it is doing. Adopting the
    // connection now would install a live wire on a client that has been shut,
    // against a machine the app has already moved off.
    if (shut) {
      next.close();
      return "this client closed the connection";
    }
    conn = next;
    watch(next);
    liveSince = now();
    if (restarted) {
      // A server that restarted kept nothing: not the op log, not the shells,
      // not the runs. Refusing to talk to it was this client's old answer, and
      // it made the ordinary overnight case unrecoverable without a human —
      // the daemon idles out a minute after its last client leaves
      // (bun/daemon.ts), so a laptop that slept ALWAYS wakes to a different
      // process than the one it left.
      //
      // Said as a `lost` and then a `live` rather than as a live connection
      // with a footnote, because that pair is exactly what the app above does
      // about it: hold what has not been saved, then settle it against a server
      // that has moved on, and line the runs back up with what is actually
      // running (notes/store.ts holdSaves, editor/bridge.ts reconcileRuns).
      //
      // What is failed is what carries an OP, which is the same line the op log
      // itself is drawn on (wire.ts needsOp): a write replayed into an empty
      // record could apply twice, and a read is a question about right now that
      // any server holding the notes can answer. So a note list that was in
      // flight when the daemon turned over simply arrives.
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
    // Under the SAME op ids. The server answers from its record if it ran
    // them already, and runs them if it did not; either way once.
    for (const held of [...inflight.values()]) issue(held);
    return null;
  }

  /**
   * The ladder is spent. Everything a caller can see about being `lost` becomes
   * true — nothing in flight, nothing accepted, saving suspended above — and
   * the dialling carries on quietly underneath at `RETRY_EVERY_MS`.
   *
   * The two halves are deliberately not the same fact. Reporting `reconnecting`
   * through the beat would be friendlier and would be a lie with teeth: a
   * request made in that state WAITS, and waiting on a wire that is beating
   * every half minute is the hang this whole phase exists to remove.
   */
  function stall(detail: string, wake: () => void = () => {}): void {
    if (retryEveryMs <= 0) return give(detail, wake);
    announce("lost", detail);
    strand(new Error(detail));
    wake();
    void beating();
  }

  async function beating(): Promise<void> {
    while (!shut && state === "lost") {
      await new Promise<void>((resolve) => {
        interrupt = resolve;
        void sleep(retryEveryMs).then(resolve);
      });
      interrupt = null;
      if (shut || state !== "lost") return;
      const why = await attempt(() => {});
      if (why === null) return;
      announce("lost", `Cannot reach the server: ${why}.`);
    }
  }

  // Over: the server said goodbye, or nobody is going to dial again. Recovery
  // from here is choosing the connection again (interactions.md §4-1), which
  // rebuilds everything from boot: nothing in this module could re-establish a
  // session's state by itself, and pretending otherwise would mean an app that
  // looks connected to sessions that no longer exist.
  function give(detail: string, wake: () => void = () => {}): void {
    announce("lost", detail);
    strand(new Error(detail));
    wake();
    settleClosed();
  }

  /** Everything waiting on a wire that will not carry it, told so at once. A
   * request that hangs forever is indistinguishable from a slow one, and it is
   * what makes a disconnected app look like a working one. */
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
    // Asked of the CURRENT connection rather than of the one that opened this
    // ladder. A reconnect can land on a different server (`instance` in the
    // handshake is how we know), and if it did, what it answers is its own
    // business and not its predecessor's.
    supports: (method: string) => conn.supports(method),
    farewell: () => goodbye,
    // Whatever this client is doing, do it now. Live, that is a probe on the
    // wire that may already be dead; lost, it is the next beat brought forward
    // to this instant. Mid-ladder it is nothing, and that is the honest answer:
    // the next rung is seconds away and a second dial in parallel with it is
    // two ssh children racing to be the one connection.
    recheck() {
      if (shut) return;
      if (state === "live") return conn.recheck();
      interrupt?.();
    },
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
      // So a beat that is asleep wakes, sees `shut`, and stops, instead of
      // dialling a server this client has finished with in half a minute.
      interrupt?.();
      conn.close();
      settleClosed();
    },
  };
}

/** The default wait, and unref'd for the reason repeatEvery's timer is: a
 * client that is only counting down to its next attempt is not a reason for a
 * process to stay alive, and the beat below counts down forever. */
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
 * A type rather than a wording, because of who else is holding an explanation
 * at that moment. Nearly every way of failing to reach a server happens BEFORE
 * the protocol starts, so the caller that dials over ssh keeps ssh's stderr and
 * puts it in front of the transport's account, which for all of those is the
 * useless "the connection to the server closed" (bun/connections.ts
 * `explainDial`). A refused handshake is the one failure on the other side of
 * that line: the far end ran, spoke, and was understood well enough to be
 * disagreed with, and by then stderr holds nothing but the far end's own
 * startup banner. This says "the protocol already answered, do not paraphrase
 * it with ssh's leftovers".
 */
export class Refused extends Error {
  override readonly name = "Refused";
}

/**
 * This server does not have the method that was just called (remote.md §11).
 *
 * Deliberately NOT a ConnectionLost: the wire is fine, and replaying this on a
 * reconnect would re-ask a server that has already answered as clearly as it
 * ever will. It is a refusal, and it is reported like any other one.
 *
 * It carries the method rather than only wording it, so a caller that wants to
 * fall back can branch on the name instead of parsing English.
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
