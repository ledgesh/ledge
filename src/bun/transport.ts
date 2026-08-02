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
  toBase64,
  WireError,
  writeMessage,
  type RequestHandlers,
  type ServerPush,
  type WireMessage,
} from "../shared/wire";
import type { Duplex } from "../shared/transport";
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
