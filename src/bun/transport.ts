// The server's half of a connection, and the transports a process can offer
// (remote.md §3).
//
// The client's half is shared/transport.ts, which is portable; this file is
// what a server needs and what only Bun can do. The two are one thing described
// twice: the server dispatches `req` frames into the handler map createServer
// returned and writes its pushes out, and the client presents that same handler
// map as its `requests`. That symmetry is what lets bun/index.ts bind either one
// to Electrobun's RPC without knowing which it got, and it is the reason the
// remote path is not a second implementation.
//
// The transport underneath is a duplex byte stream and nothing more. A local
// server is a child process's pipes; a remote one is `ssh <target>
// ledge-server serve`, which is the same pipes with a longer wire. Neither
// end opens a port.
import {
  BinaryHolder,
  checkHello,
  encodeControl,
  FrameDecoder,
  fromBase64,
  hello,
  parseControl,
  PUSH_MESSAGES,
  sessionHold,
  toBase64,
  WireError,
  writeMessage,
  type RequestHandlers,
  type ServerPush,
  type WireMessage,
} from "../shared/wire";
import { DEAD_AFTER_MS, repeatEvery, type Duplex, type HeartbeatOpts } from "../shared/transport";
import type { OpLog } from "./opLog";

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
  /** What that client calls itself (wire.ts `Hello.label`), for the presence
   * list every other client is pushed (remote.md §7). "" until the hello, and
   * "" for a client that gave no name. */
  label(): string;
  /** How long this client asked for its sessions to be held once this
   * connection ends, under `ServerOpts.holdMax` (wire.ts `Hello.hold`). 0 until
   * a hello has arrived, and 0 for a client that did not ask — which are the
   * same answer, because neither is a client to keep a process for. */
  hold(): number;
  closed: Promise<void>;
  close(why?: string): void;
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
  /**
   * Called once the client's hello has been accepted, and never for a socket
   * that opened and said nothing.
   *
   * The distinction is the daemon's: it serves one client and hands the
   * session to whoever arrived last, and a connection that has not identified
   * itself is not a client yet. Probing the socket to see whether a daemon is
   * behind it is a connect and an immediate close (bun/daemon.ts
   * clearStaleSocket), and on the accept that would displace the person
   * actually using the server.
   */
  greeted?(): void;
  /**
   * The longest session hold this server will grant, in ms (wire.ts
   * `Hello.hold`). Announced in its own hello, before any client has asked, and
   * applied to whatever the client does ask for.
   *
   * Absent means none, which is right for a server that dies with its
   * connection: there is nothing to hold sessions FOR. The daemon supplies its
   * own ceiling, because it is the thing being kept alive.
   */
  holdMax?: number;
  /**
   * How long a client may say nothing before this connection is collected, in
   * ms. 0 turns it off, which is for a test that is not about it.
   *
   * The mirror of the client's heartbeat and not a second mechanism: a live
   * client probes whenever it has sent nothing for five seconds
   * (shared/transport.ts), so silence for eight times that is a client that is
   * not there. Without this, a wire that black-holes leaves the daemon a
   * connection nobody will ever close — its sessions open, its idle exit never
   * armed, and a shell running on somebody's server for as long as the machine
   * is up. TCP will not end it either: a black hole has no FIN to send, and
   * sshd probes its clients only if somebody configured it to.
   */
  silentMs?: number;
  /** The timer, injectable exactly as the client's is, so a test can be about
   * the rule rather than about forty seconds. */
  repeat?: NonNullable<HeartbeatOpts["repeat"]>;
}

/**
 * How long a server waits before deciding a silent client has gone.
 *
 * Twice what the client allows itself (`DEAD_AFTER_MS`), because a client that
 * decided its own wire was dead is already re-dialling and the connection here
 * is a ghost by then; this only has to outlast that decision, generously, so
 * that a client whose timer merely ran late is never hung up on. Under the
 * daemon's `IDLE_EXIT_MS` for the other side of it: a ghost should delay an
 * unattended daemon's exit by less than one idle window, not forever.
 */
export const SILENT_MS = DEAD_AFTER_MS * 2;

export function serverConnection(duplex: Duplex, opts: ServerOpts): ServerConnection {
  const { build, ops, coalesce, instance = "", greeted: onGreet, holdMax = 0 } = opts;
  const silentMs = opts.silentMs ?? SILENT_MS;
  // Set by any bytes at all and cleared by the watchdog below, so one quiet
  // window is what it takes. Inbound only: a server pushing to a client that
  // has gone would otherwise keep resetting its own patience, and with two
  // clients a broadcast would keep a ghost alive for as long as the other one
  // was there.
  let heardFromClient = false;
  let stopWatching: (() => void) | null = null;
  const decoder = new FrameDecoder();
  const incoming = new BinaryHolder();
  let handlers: RequestHandlers | null = null;
  let greeted = false;
  let peerClient = "";
  let peerLabel = "";
  // What this connection's client asked for, under this server's ceiling. Read
  // after the connection ends, by whoever decides how long to stay (daemon.ts).
  let peerHold = 0;
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
    stopWatching?.();
    stopWatching = null;
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
      // Already bounded and stripped by parseControl (wire.ts cleanLabel), so
      // what is kept here is displayable by construction.
      peerLabel = msg.label;
      peerHold = sessionHold(msg.hold, holdMax);
      onGreet?.();
      return;
    }
    switch (msg.t) {
      case "req": {
        const p = incoming.claim(msg, "req", msg.m);
        if (handlers) void dispatch(msg.id, msg.m, p, msg.op);
        else waiting.push({ id: msg.id, m: msg.m, p, ...(msg.op === undefined ? {} : { op: msg.op }) });
        return;
      }
      case "ping":
        // Answered here rather than dispatched, and that is the point of
        // answering it in the transport at all: the handler map arrives after
        // the vault has loaded (`waiting` above), and a heartbeat queued behind
        // a slow boot would report a dead server that is merely starting.
        //
        // What a pong therefore proves is that this process is reading its
        // socket and writing to it, which is exactly the question, and more
        // than any hop between here and the client can answer on its behalf.
        return send({ t: "pong" });
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
    heardFromClient = true;
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
    stopWatching?.();
    stopWatching = null;
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

  raw(encodeControl(hello("server", build, "", instance, holdMax)));
  // Without a reason, because there is nobody to tell. A `bye` is a decision
  // the client is meant to read and stop re-dialling over (shared/transport.ts
  // farewell), and a client that has said nothing for this long is by
  // definition not reading anything. It also covers a socket that connected and
  // never greeted, which until now could sit there for as long as the process
  // did.
  if (silentMs > 0) {
    stopWatching = (opts.repeat ?? repeatEvery)(silentMs, () => {
      if (heardFromClient) {
        heardFromClient = false;
        return;
      }
      console.error(`[wire] a client said nothing for ${Math.round(silentMs / 1000)}s; hanging up on it`);
      close();
    });
  }

  return {
    push,
    serve(next) {
      handlers = next;
      for (const { id, m, p, op } of waiting.splice(0)) void dispatch(id, m, p, op);
    },
    client: () => peerClient,
    label: () => peerLabel,
    hold: () => peerHold,
    closed,
    close,
  };
}

// --- the transports a process has --------------------------------------------

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
 * A socket's write half, with the kernel's send buffer respected.
 *
 * `Socket.write` writes what fits and RETURNS HOW MUCH THAT WAS. Discarding
 * that number drops every byte past the buffer, and the loss is silent in the
 * worst possible way: the stream stops mid-frame, so the reader sits forever on
 * a length prefix whose bytes will never arrive, and every response and push
 * queued behind it is stuck there too. A note stops loading, and then the note
 * list stops updating, and the connection still looks live because it is.
 *
 * The buffer is small and its size is the platform's: about 8KB for a unix
 * socket on macOS and about 208KB on Linux. So the size at which a note
 * disappears is a property of the machine the server runs on, and a fast reader
 * never sees it at all — it drains the buffer as fast as the writer fills it.
 * That is why this survived the ssh probe and every test: it takes a reader
 * slow enough to push back, which is what a phone is (ios.md §2 — every frame
 * crosses the WKWebView bridge as base64 through `evaluateJavaScript`).
 *
 * `drain` is the socket handler that says the buffer has room again. A caller
 * that does not wire it up gets a stall instead of a truncation, which is not
 * an improvement.
 */
export function socketWriter(socket: { write(bytes: Uint8Array): number }): {
  write(bytes: Uint8Array): void;
  drain(): void;
} {
  // The unwritten remainder, as one buffer. One rather than a queue of chunks
  // because the frames it holds are already a byte stream: nothing downstream
  // cares where the boundaries between write() calls were.
  let held: Uint8Array | null = null;

  function pump(): void {
    while (held !== null) {
      const wrote = socket.write(held);
      // Not `wrote < 1`: a socket that has gone away returns -1 here, and
      // spinning on it would be a busy loop against a dead peer. Both cases
      // mean "stop and wait", and a closed socket's drain never comes.
      if (wrote <= 0) return;
      if (wrote >= held.length) {
        held = null;
        return;
      }
      held = held.subarray(wrote);
    }
  }

  return {
    write(bytes) {
      if (held === null) {
        held = bytes;
      } else {
        const merged = new Uint8Array(held.length + bytes.length);
        merged.set(held, 0);
        merged.set(bytes, held.length);
        held = merged;
      }
      pump();
    },
    drain: pump,
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
