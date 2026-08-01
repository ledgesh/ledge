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
  checkHello,
  encodeControl,
  FrameDecoder,
  hello,
  parseControl,
  PUSH_MESSAGES,
  REQUEST_METHODS,
  WireError,
  type Hello,
  type WireMessage,
} from "../shared/wire";
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
  /** The server's hello, once accepted. Rejects with the refusal when the two
   * ends disagree about the protocol, and when the server dies before saying
   * anything at all. */
  ready: Promise<Hello>;
  closed: Promise<void>;
  close(): void;
}

// --- the server's end --------------------------------------------------------

export function serverConnection(duplex: Duplex, build: string): ServerConnection {
  const decoder = new FrameDecoder();
  let handlers: RequestHandlers | null = null;
  let greeted = false;
  let peerClient = "";
  let open = true;
  // Requests that beat createServer to the door. A server sends its hello
  // immediately (it is a constant, and waiting would make a slow boot look
  // like a dead pipe), so a brisk client can have a request in flight before
  // the vault has finished loading.
  const waiting: Array<{ id: number; m: string; p: unknown }> = [];

  let settle!: () => void;
  const closed = new Promise<void>((resolve) => (settle = resolve));

  function send(msg: WireMessage): void {
    if (!open) return;
    try {
      duplex.write(encodeControl(msg));
    } catch (err) {
      console.error("[wire] could not write to the client:", err);
      close();
    }
  }

  function close(why?: string): void {
    if (!open) return;
    if (why !== undefined) send({ t: "bye", why });
    open = false;
    try {
      duplex.close();
    } catch {
      // Already gone. Closing is best-effort by nature.
    }
    settle();
  }

  async function dispatch(id: number, method: string, params: unknown): Promise<void> {
    // hasOwn, not `in`: the handler map is an object literal, so anything
    // reached through the prototype (`constructor`, `toString`) is the client
    // trying its luck rather than a method.
    const map = handlers as unknown as Record<string, (p: unknown) => unknown> | null;
    if (!map || !Object.hasOwn(map, method)) {
      send({ t: "err", id, e: `unknown method: ${method}` });
      return;
    }
    try {
      send({ t: "res", id, r: await map[method]!(params) });
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
      case "req":
        if (handlers) void dispatch(msg.id, msg.m, msg.p);
        else waiting.push({ id: msg.id, m: msg.m, p: msg.p });
        return;
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
      if (frame.type !== 0) return close("binary frames are not routed yet");
      try {
        handle(parseControl(frame.text));
      } catch (err) {
        console.error("[wire]", err instanceof Error ? err.message : err);
        return close(err instanceof WireError ? err.message : "unreadable message");
      }
    }
  };
  duplex.onClose = () => {
    open = false;
    settle();
  };

  const push = Object.fromEntries(
    PUSH_MESSAGES.map((m) => [m, (p: unknown) => send({ t: "push", m, p })]),
  ) as unknown as ServerPush;

  send(hello("server", build));

  return {
    push,
    serve(next) {
      handlers = next;
      for (const { id, m, p } of waiting.splice(0)) void dispatch(id, m, p);
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
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
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

  function send(msg: WireMessage): void {
    if (!open) return;
    try {
      duplex.write(encodeControl(msg));
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function fail(err: Error): void {
    if (!open) return;
    open = false;
    refuseHello(err);
    for (const { reject } of pending.values()) reject(err);
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
        pending.get(msg.id)?.resolve(msg.r);
        pending.delete(msg.id);
        return;
      }
      case "err": {
        pending.get(msg.id)?.reject(new Error(msg.e));
        pending.delete(msg.id);
        return;
      }
      case "push": {
        // Validated against the schema's own list: a name off it would index
        // the push object with whatever the peer chose.
        if ((PUSH_MESSAGES as readonly string[]).includes(msg.m)) {
          (opts.push as unknown as Record<string, (p: unknown) => void>)[msg.m]!(msg.p);
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
      if (frame.type !== 0) return fail(new WireError("the server sent a binary frame, which nothing routes yet"));
      try {
        handle(parseControl(frame.text));
      } catch (err) {
        return fail(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };
  duplex.onClose = () => {
    fail(new Error(farewell ?? "the connection to the server closed"));
  };

  async function call(method: string, params: unknown): Promise<unknown> {
    // The handshake gates the first call and nothing after it: `ready` is
    // already settled by the time a second request is made, so this costs one
    // microtask, not a round trip (remote.md §12).
    await ready;
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ t: "req", id, m: method, p: params });
    });
  }

  // Deliberately not a Proxy: a Proxy answers to `then`, so a handler map that
  // reached an `await` would be mistaken for a thenable and never resolve.
  const requests = Object.fromEntries(
    REQUEST_METHODS.map((m) => [m, (p: unknown) => call(m, p)]),
  ) as unknown as RequestHandlers;

  send(hello("client", opts.build, opts.client ?? ""));

  return {
    requests,
    ready,
    closed,
    close: () => fail(new Error("this client closed the connection")),
  };
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
