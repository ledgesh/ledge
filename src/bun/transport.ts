// The server's half of a connection, and the transports a process can offer
// (remote.md §3).
//
// The client's half is shared/transport.ts, which is portable. This file holds
// what a server needs and what only Bun can do. The two halves are symmetric.
// The server dispatches `req` frames into the handler map createServer returned
// and writes its pushes out. The client presents that same map as its
// `requests`. So bun/index.ts binds either one to Electrobun's RPC without
// knowing which it got, and the remote path is not a second implementation.
//
// The transport underneath is a duplex byte stream. A local server is a child
// process's pipes. A remote one is `ssh <target> ledge-server serve`, the same
// pipes over a longer wire. Neither end opens a port.
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
  /** The connected client's id, from its hello (remote.md §5). "" until the
   * hello arrives. A getter rather than a promise: no request is dispatched
   * before the handshake, so a handler reading this always has the answer. */
  client(): string;
  /** The device that client runs on (wire.ts `Hello.device`), which the vault
   * scopes an unlock to (locking.md §3a). A client that named none is its own
   * device, so this falls back to `client()` and never answers "". */
  device(): string;
  /** What that client calls itself (wire.ts `Hello.label`), for the presence
   * list every other client is pushed (remote.md §7). "" until the hello, and
   * "" for a client that gave no name. */
  label(): string;
  /** How long this client asked for its sessions to be held once this
   * connection ends, under `ServerOpts.holdMax` (wire.ts `Hello.hold`). 0
   * before the hello arrives, and 0 for a client that did not ask. Both mean
   * the same thing: no reason to keep a process for this client. */
  hold(): number;
  closed: Promise<void>;
  /** Hangs up on this client. `why` goes out as a `bye` carrying that reason,
   * and `back` marks this server as expecting to be reachable again, so the
   * client keeps re-dialling. A `bye` without `back` is final and the client
   * stops (wire.ts `bye`, shared/transport.ts `farewell`). */
  close(why?: string, back?: boolean): void;
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
  /** Which run of the server this is (wire.ts `Hello.instance`). The daemon
   * mints one per process, and a server that dies with its connection leaves
   * it empty. A reconnecting client compares it across dials to decide whether
   * replaying an in-flight request is safe (shared/transport.ts). */
  instance?: string;
  /** The dedupe window (remote.md §7). Supplied by the daemon, which owns the
   * server across connections: a window scoped to one connection is forgotten
   * at the moment a replay needs it. Absent means no deduping, for a server
   * that dies with its connection. */
  ops?: OpLog;
  /** Overrides for the output coalescer, for tests that cannot wait 30ms. */
  coalesce?: { ms?: number; bytes?: number };
  /**
   * Called once the client's hello has been accepted, and never for a socket
   * that opened and said nothing. The daemon registers a connection on the
   * hello, not on the accept (remote.md §1). Probing for a daemon behind the
   * socket file is a connect and an immediate close (bun/daemon.ts
   * clearStaleSocket), and must not count as somebody using the server.
   */
  greeted?(): void;
  /**
   * The longest session hold this server grants, in ms (wire.ts `Hello.hold`).
   * Announced in this server's own hello, before any client has asked, and
   * applied to whatever the client does ask for (wire.ts `sessionHold`).
   *
   * Absent means no hold, for a server that dies with its connection: there is
   * no process left to hold sessions in. The daemon passes its own
   * `HOLD_MAX_MS`, because it is the process a held session lives in.
   */
  holdMax?: number;
  /**
   * How long a client may say nothing before this connection is closed, in ms.
   * 0 turns it off, for a test that is not about it. This mirrors the client's
   * heartbeat rather than adding a second timer: a live client probes after
   * five seconds of sending nothing (shared/transport.ts), so eight times that
   * much silence is a client that is not there. What an uncollected connection
   * costs the daemon is in remote.md §7.
   */
  silentMs?: number;
  /** The repeating timer, injectable as the client's is (shared/transport.ts
   * `HeartbeatOpts.repeat`), so a test does not wait forty seconds. */
  repeat?: NonNullable<HeartbeatOpts["repeat"]>;
}

/**
 * How long a server waits before deciding a silent client has gone.
 *
 * Twice the client's own `DEAD_AFTER_MS`. A client that called its wire dead
 * is already re-dialling, so this only has to outlast that decision, with
 * enough room that a client whose timer ran late is never hung up on. It stays
 * under the daemon's `IDLE_EXIT_MS` (bun/daemon.ts), so a ghost connection
 * delays an unattended daemon's exit by less than one idle window.
 */
export const SILENT_MS = DEAD_AFTER_MS * 2;

export function serverConnection(duplex: Duplex, opts: ServerOpts): ServerConnection {
  const { build, ops, coalesce, instance = "", greeted: onGreet, holdMax = 0 } = opts;
  const silentMs = opts.silentMs ?? SILENT_MS;
  // Set by any inbound bytes and cleared by the watchdog below, so one quiet
  // window is enough. Inbound only: if outbound traffic counted, a server
  // pushing to a client that has gone would keep resetting its own patience,
  // and a broadcast would keep a ghost alive for as long as another client
  // stayed connected.
  let heardFromClient = false;
  let stopWatching: (() => void) | null = null;
  const decoder = new FrameDecoder();
  const incoming = new BinaryHolder();
  let handlers: RequestHandlers | null = null;
  let greeted = false;
  let peerClient = "";
  let peerDevice = "";
  let peerLabel = "";
  // What this connection's client asked for, under this server's ceiling. Read
  // after the connection ends, by whoever decides how long to stay (daemon.ts).
  let peerHold = 0;
  let open = true;
  // Requests that arrived before `serve` supplied the handler map. Everything
  // in the server's hello is known before the handlers are, so it goes out
  // immediately and a fast client can have a request in flight before the vault
  // has finished loading. Holding the hello back until the handlers arrived
  // would make a slow boot look like a dead pipe.
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
    // Every message other than a terminalOutput push flushes the coalescer
    // first. Held-back terminal bytes must not overtake the terminalAttach
    // response that precedes them, or the drawer replays its scrollback and
    // then paints older output on top of the snapshot (remote.md §3).
    if (msg.t !== "push" || msg.m !== "terminalOutput") flushOutput();
    if (msg.t === "res" || msg.t === "push") writeMessage(raw, msg, msg.t, method);
    else raw(encodeControl(msg));
  }

  function close(why?: string, back = false): void {
    if (!open) return;
    if (why !== undefined) send({ t: "bye", why, ...(back ? { back: true } : {}) });
    open = false;
    stopWatching?.();
    stopWatching = null;
    stopCoalescing();
    try {
      duplex.close();
    } catch {
      // Already gone. Closing is best-effort.
    }
    settle();
  }

  // --- terminal output, coalesced (remote.md §3) ------------------------------
  //
  // The drain loop pushes whatever a shell produced every 8ms, which is free
  // in-process and 125 frames a second down a wire. This holds those pushes
  // back on a quiet moment rather than on a fixed delay, the way Nagle's
  // algorithm does: the first chunk after a pause goes out at once, so an
  // echoed keystroke is never delayed. Only a shell producing continuously
  // waits for the interval.
  //
  // Chunks are held per session, since two drawers are two streams. Within a
  // session they are concatenated, because xterm.js cares about the byte order
  // and nothing else.
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
    // hasOwn, not `in`: the handler map is an object literal, so a name
    // reached through the prototype (`constructor`, `toString`) is not a
    // method and must not dispatch.
    const map = handlers as unknown as Record<string, (p: unknown) => unknown> | null;
    if (!map || !Object.hasOwn(map, method)) {
      send({ t: "err", id, e: `unknown method: ${method}` });
      return;
    }
    try {
      // The op keys the dedupe window (remote.md §7). The client id is part of
      // that key, so a recorded outcome only ever answers the client that made
      // it: the window outlives the connection that filled it, and one op log
      // serves every connection the daemon accepts (bun/daemon.ts).
      const run = async () => map[method]!(params);
      send({ t: "res", id, r: await (ops && op !== undefined ? ops.run(`${peerClient}\u0000${op}`, run) : run()) }, method);
    } catch (err) {
      // The message only, no stack. Guards in notes.ts throw their refusal as
      // text and the view shows that text. A stack would add the server's own
      // paths and nothing a user can act on.
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
      // Empty reads as "this client is its own device" (wire.ts `Hello.device`
      // for why that is the safe reading). Resolved here so no caller has to
      // remember the fallback.
      peerDevice = msg.device === "" ? msg.client : msg.device;
      // Already bounded and stripped of control characters by parseControl
      // (wire.ts cleanLabel), so the string kept here is displayable.
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
        // Answered in the transport rather than dispatched to a handler: the
        // handler map arrives only after the vault has loaded (`waiting`
        // above), and a heartbeat queued behind a slow boot would report a
        // dead server that is merely starting. The pong still comes from this
        // process, which is more than any hop between here and the client can
        // answer on its behalf (shared/transport.ts `PROBE_EVERY_MS`).
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
  // The watchdog closes without a reason, because a client this silent is not
  // reading one. A `bye` that does not say `back` tells the client to stop
  // re-dialling (shared/transport.ts `farewell`). This also collects a socket
  // that connected and never greeted, which would otherwise sit there for as
  // long as the process did.
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
    device: () => peerDevice,
    label: () => peerLabel,
    hold: () => peerHold,
    closed,
    close,
  };
}

// --- the transports a process has --------------------------------------------

/**
 * Wraps an I/O pair as a Duplex whose read loop starts only once `onData` is
 * set. Creating a duplex and handing it on are two statements, and a chunk
 * delivered in between would be a lost frame.
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
      // A reader loop rather than `for await`: Bun iterates a ReadableStream,
      // but the DOM lib this repo compiles against does not declare it as
      // iterable.
      const reader = io.incoming().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) onData?.(value);
        }
      } catch (err) {
        // A pipe that broke mid-read. The onClose call below is the report.
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
 * `Socket.write` writes what fits and returns how much that was. Discarding
 * that number drops every byte past the buffer, silently and mid-frame: the
 * reader waits forever on a length prefix whose bytes never arrive, and every
 * response and push queued behind it waits too. In the field that shows as a
 * note that stops loading, then a note list that stops updating, on a
 * connection that still looks live. remote.md §1 has the per-platform buffer
 * sizes. Only a reader slow enough to push back provoked it, and the first was
 * an iOS client, which crosses every frame to its webview as base64
 * (ios.md §2).
 *
 * The caller must wire `drain`, the socket handler that says the buffer has
 * room again. Without it the remainder waits for the next write to retry it,
 * so a caller that writes nothing more stalls instead of truncating.
 */
export function socketWriter(socket: { write(bytes: Uint8Array): number }): {
  write(bytes: Uint8Array): void;
  drain(): void;
} {
  // The unwritten remainder, as one buffer rather than a queue of chunks: what
  // it holds is already a byte stream, and the boundaries between write()
  // calls carry no meaning downstream.
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
 * A child process's stdio. Both server commands are the same but for the
 * `ssh <target>` in front: `ssh <target> ledge-server serve` for another
 * machine and `ledge-server serve` for this one, so the remote path is not a
 * second, less-tested code path (remote.md §1).
 *
 * stderr is inherited, so the server's log lines land on this process's
 * terminal (and, over ssh, on ssh's). stdout carries the protocol and nothing
 * else.
 *
 * `onStderr` switches stderr to a pipe and reports those lines. A dial that
 * fails does so before any frame arrives, so ssh's stderr is the only account
 * of what went wrong (bun/index.ts, connections.ts explainDial). It is opt-in
 * because a pipe nobody drains blocks the child once the buffer fills, and the
 * callback guarantees somebody is draining it.
 */
export function spawnDuplex(
  cmd: readonly string[],
  opts?: { cwd?: string; env?: Record<string, string>; onStderr?: (text: string) => void },
): Duplex {
  if (cmd.length === 0) throw new Error("a server command cannot be empty");
  const proc = Bun.spawn({
    cmd: [...cmd],
    stdin: "pipe",
    stdout: "pipe",
    stderr: opts?.onStderr ? "pipe" : "inherit",
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    // Inherited unless the caller passes overrides: with no `env` here, the
    // child gets this process's. With overrides, process.env is merged under
    // them rather than replaced, because a local server needs the user's PATH
    // and SSH_AUTH_SOCK and `ssh` needs them too.
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  if (opts?.onStderr) {
    const report = opts.onStderr;
    // Drained to the end and never awaited: these lines are diagnostics, and a
    // dial that fails must not wait for the child's last byte before saying so.
    void (async () => {
      const decoder = new TextDecoder();
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) report(decoder.decode(value, { stream: true }));
        }
      } catch {
        // The child went away mid-read. The lines already reported stand.
      }
    })();
  }
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
