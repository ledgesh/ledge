// The server as a process, over a real unix socket (remote.md §1).
//
// serve.fs.test.ts proves the assembly from outside — two processes, an actual
// `bun serve.ts serve`, a run that outlives its client. This proves the rules
// that assembly cannot easily provoke: who wins when two clients connect, and
// when a daemon nobody is using decides to stop.
//
// The scratch APP_HOME is the preload's (src/test-preload.ts), so the socket
// and the pid file land beside a throwaway registry and never near the real
// ~/.ledge.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, connectToDaemon, IDLE_EXIT_NEVER, type Daemon } from "./daemon";
import { clientConnection } from "../shared/transport";
import { BUILD_VERSION } from "../shared/version";
import { PUSH_MESSAGES, type ServerPush } from "../shared/wire";
import type { RunEvent } from "../shared/rpc-schema";

const push = Object.fromEntries(PUSH_MESSAGES.map((m) => [m, () => {}])) as unknown as ServerPush;

const started: Daemon[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const d of started.splice(0)) d.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function daemonIn(opts: { idleMs?: number; holdMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ledge-daemon-unit-"));
  dirs.push(dir);
  const socketPath = join(dir, "server.sock");
  const pidPath = join(dir, "server.pid");
  const d = await startDaemon({
    socketPath,
    pidPath,
    idleMs: opts.idleMs ?? 60_000,
    ...(opts.holdMs === undefined ? {} : { holdMs: opts.holdMs }),
    build: BUILD_VERSION,
  });
  started.push(d);
  return { d, socketPath, pidPath };
}

const connect = async (socketPath: string, who: string, hold?: number) => {
  const duplex = await connectToDaemon({ socketPath, spawn: () => {}, timeoutMs: 2000 });
  return clientConnection(duplex, { push, build: BUILD_VERSION, client: who, ...(hold === undefined ? {} : { hold }) });
};

describe("one client at a time", () => {
  // `attached` and the scrollback ring are per SESSION, not per client
  // (bun/server.ts), so two clients watching one drawer would be one stream
  // with two readers and no rule for who gets what. Displacing is the honest
  // version of remote.md §8's one connection at a time — and it is what makes
  // a reconnect work, since the half-open connection nobody noticed was dead
  // gets taken over rather than fought with.
  test("a second connection displaces the first, and says why", async () => {
    const { socketPath } = await daemonIn();
    const first = await connect(socketPath, "mac-1");
    await first.ready;

    const second = await connect(socketPath, "phone-1");
    await second.ready;
    await first.closed; // resolves, rather than hanging: it was hung up on
    // And the one that took over is the one being served.
    expect(await second.requests.vaultState({})).toBeDefined();
  });

  // A `bye` with a reason, not a silent hangup: without it the displaced end
  // sees only a closed pipe and cannot tell being taken over from the server
  // dying (wire.ts).
  test("the displaced client is told why, rather than just cut off", async () => {
    const { socketPath } = await daemonIn();
    const first = await connect(socketPath, "mac-1");
    await first.ready;
    const second = await connect(socketPath, "phone-1");
    await second.ready;
    await first.closed;
    await expect(first.requests.vaultState({})).rejects.toThrow("another client connected to this server");
    // And the reason survives as a REASON rather than only as an error
    // message: the client's ladder reads it to tell a server that decided from
    // a wire that broke, and re-dialling the first would put two clients back
    // to displacing each other forever (shared/transport.ts).
    expect(first.farewell()).toBe("another client connected to this server");
  });

  // The rule is about clients, and a socket that has not said who it is is not
  // one yet. This is exactly what clearStaleSocket does to decide whether a
  // daemon is behind a socket file — connect, then hang up — so on the accept
  // rather than on the hello it would throw the person using the server off
  // their session every time a second daemon tried to start.
  test("a socket that never says who it is takes nothing from the client that did", async () => {
    const { socketPath, pidPath } = await daemonIn();
    const client = await connect(socketPath, "mac-1");
    await client.ready;

    await expect(startDaemon({ socketPath, pidPath, idleMs: 1000 })).rejects.toThrow();

    expect(await client.requests.vaultState({})).toBeDefined();
    expect(client.farewell()).toBe(null);
  });
});

describe("a daemon nobody is using", () => {
  // It exits at all because the alternative is a process per machine forever,
  // started by an ssh nobody remembers making.
  // The idle windows below are milliseconds where production uses a minute,
  // and they have to stay comfortably longer than a local socket handshake:
  // the daemon arms its timer at startup, so a window shorter than the first
  // connection takes would have it exiting for the right reason at the wrong
  // moment, and the test would pass without proving anything.
  test("stops once its last client has gone", async () => {
    const { d, socketPath, pidPath } = await daemonIn({ idleMs: 150 });
    const client = await connect(socketPath, "mac-1");
    await client.ready;
    expect(existsSync(pidPath)).toBe(true);
    client.close();
    await d.done;
    // Both artifacts cleaned up, so the next daemon does not have to sweep.
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });

  test("does not stop while a client is still there", async () => {
    const { d, socketPath } = await daemonIn({ idleMs: 200 });
    const client = await connect(socketPath, "mac-1");
    await client.ready;
    // Three times the window, so a timer that was never cleared would have
    // fired by now.
    const raced = await Promise.race([d.done.then(() => "exited"), new Promise((r) => setTimeout(() => r("still up"), 600))]);
    expect(raced).toBe("still up");
    client.close();
  });

  // The daemon a person started, rather than one an ssh conjured: a systemd
  // unit, or the container's PID 1. It has to survive having no client at all,
  // because the alternative is a supervisor restarting it every minute for
  // correctly deciding nobody was home.
  test("stays put when it was asked to, with no client ever", async () => {
    const { d, socketPath, pidPath } = await daemonIn({ idleMs: IDLE_EXIT_NEVER });
    const raced = await Promise.race([
      d.done.then(() => "exited"),
      new Promise((r) => setTimeout(() => r("still up"), 500)),
    ]);
    expect(raced).toBe("still up");
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
    d.stop();
    await d.done;
  });
});

// The windows here are milliseconds where production is minutes, and the same
// constraint applies as above: a hold has to be comfortably longer than the
// idle window it replaces, or the two are indistinguishable and the test proves
// nothing about which one was used.
describe("a client that said it is coming back", () => {
  // iOS suspends an app shortly after it leaves the foreground and its socket
  // dies with it (ios.md §5), so on a phone "no client" is the ordinary state
  // of a connection that is still wanted. What the ask buys is the one thing
  // `running()` is right to ignore: a shell sitting at a prompt.
  test("keeps an idle session past the window that would have ended it", async () => {
    const { d, socketPath } = await daemonIn({ idleMs: 150, holdMs: 5_000 });
    const client = await connect(socketPath, "phone-1", 700);
    await client.ready;
    // A drawer's shell, spawned and then left alone. Nothing is executing in
    // it, so `running()` is false and the old rule would throw it away.
    await client.requests.terminalAttach({ sessionId: "note-1" });
    client.close();

    const raced = await Promise.race([
      d.done.then(() => "exited"),
      new Promise((r) => setTimeout(() => r("still up"), 450)),
    ]);
    expect(raced).toBe("still up");
    // And it still ends: a hold is a longer deadline, not an exemption.
    await d.done;
  });

  // A hold applies to something. A client that asked for one and opened no
  // shell has nothing to come back TO, and keeping the process for it is the
  // "started by an ssh nobody remembers making" the timer exists to end.
  test("holds nothing for a client that opened no session", async () => {
    const { d, socketPath } = await daemonIn({ idleMs: 150, holdMs: 60_000 });
    const client = await connect(socketPath, "phone-1", 60_000);
    await client.ready;
    client.close();
    await d.done; // on the ordinary window, rather than the minute it asked for
  });

  // The other half of asking: the answer is not the client's to give, so an
  // ask nobody would wait through is clamped rather than refused.
  test("an absurd ask is answered with the server's own ceiling", async () => {
    const { d, socketPath } = await daemonIn({ idleMs: 150, holdMs: 400 });
    const client = await connect(socketPath, "phone-1", 60 * 60_000);
    await client.ready;
    await client.requests.terminalAttach({ sessionId: "note-1" });
    client.close();
    await d.done; // in 400ms, rather than the hour
  });

  // On the DEPARTING connection's terms, and not the longest anything ever
  // asked for. A displaced client has been told so and has stopped re-dialling
  // (shared/transport.ts): it is not coming back, and its hold is not a claim
  // on behalf of the client that took the session over.
  test("a displaced client's hold does not outlive its connection", async () => {
    const { d, socketPath } = await daemonIn({ idleMs: 150, holdMs: 60_000 });
    const phone = await connect(socketPath, "phone-1", 60_000);
    await phone.ready;
    await phone.requests.terminalAttach({ sessionId: "note-1" });

    const mac = await connect(socketPath, "mac-1"); // asks for nothing
    await mac.ready;
    await phone.closed;
    mac.close();
    await d.done; // the Mac's window, not the minute the phone asked for
  });
});

describe("runs the client that started them can no longer show", () => {
  // A run event is a push keyed by a run id, so a page that reloaded knows
  // none of them: the run would go on executing, hold the daemon under it, and
  // have no id left anywhere to stop it by. The claim at the next boot is what
  // collects it (rpc-schema inlineClaim). Driven through a real PTY, because
  // what has to be true is that the shell's foreground job actually dies.
  const watching = async (socketPath: string, who: string) => {
    const seen: RunEvent[] = [];
    const duplex = await connectToDaemon({ socketPath, spawn: () => {}, timeoutMs: 2000 });
    const conn = clientConnection(duplex, {
      push: { ...push, runEvent: (ev: RunEvent) => void seen.push(ev) },
      build: BUILD_VERSION,
      client: who,
    });
    await conn.ready;
    return { conn, seen };
  };

  const until = async (cond: () => boolean, ms = 5_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !cond()) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };

  test("a fresh page claims nothing, and the run it never learned about stops", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const first = await watching(socketPath, "phone-1");
    expect((await first.conn.requests.runBlock({ sessionId: "note-1", id: "run-1", code: "sleep 30", language: "sh" })).accepted).toBe(true);
    expect(await until(() => first.seen.some((ev) => ev.kind === "began"))).toBe(true);
    first.conn.close();

    // The page came back with no panels, so it names no runs.
    const next = await watching(socketPath, "phone-1");
    expect(await next.conn.requests.inlineClaim({ ids: [] })).toEqual({ running: [], orphaned: 1 });
    // 130 is the shell reporting the interrupt itself: the job died, and the
    // note's shell lived to say so.
    expect(await until(() => next.seen.some((ev) => ev.kind === "ended"))).toBe(true);
    expect(next.seen.find((ev) => ev.kind === "ended")).toEqual({ id: "run-1", kind: "ended", exitCode: 130 });
  });

  test("a run the client still shows is confirmed and left running", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const client = await watching(socketPath, "mac-1");
    await client.conn.requests.runBlock({ sessionId: "note-1", id: "run-1", code: "sleep 30", language: "sh" });
    expect(await until(() => client.seen.some((ev) => ev.kind === "began"))).toBe(true);

    // The wire flapped, the panel survived: the claim is what tells the server
    // this run still has somewhere to be seen.
    expect(await client.conn.requests.inlineClaim({ ids: ["run-1"] })).toEqual({ running: ["run-1"], orphaned: 0 });
    await new Promise((r) => setTimeout(r, 200));
    expect(client.seen.some((ev) => ev.kind === "ended")).toBe(false);
  });

  test("a run the server already finished is simply not confirmed", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const client = await watching(socketPath, "mac-1");
    await client.conn.requests.runBlock({ sessionId: "note-1", id: "run-1", code: "true", language: "sh" });
    expect(await until(() => client.seen.some((ev) => ev.kind === "ended"))).toBe(true);

    // The client asks about a panel whose ended event it might never have got
    // (a push with nowhere to go is dropped). Nothing to stop, and the empty
    // answer is what lets it close the panel out.
    expect(await client.conn.requests.inlineClaim({ ids: ["run-1"] })).toEqual({ running: [], orphaned: 0 });
  });
});

// Nobody attached is the ORDINARY case for a server that outlives its clients:
// the watcher fires whenever a file moves, and it goes on firing while the
// client is away. This crashed the daemon before it was a test — a
// `notesChanged` with nowhere to send it took the process down, and with it
// every session the socket exists to protect.
//
// Driven through the REAL watcher rather than by reaching into the push map,
// because the push map is nobody's business but createServer's, and the
// evidence that matters is the same either way: the daemon is still answering
// afterwards.
test("a watcher event with no client attached does not take the daemon with it", async () => {
  const { socketPath } = await daemonIn({ idleMs: 60_000 });
  const first = await connect(socketPath, "mac-1");
  await first.ready;
  const { workspaces } = await first.requests.workspaceList({});
  const root = workspaces[0]!.root;
  first.close();

  await Bun.write(join(root, "written-while-away.md"), "# Written While Away\n");
  await new Promise((r) => setTimeout(r, 400)); // past the watcher's 250ms debounce

  const second = await connect(socketPath, "mac-1");
  await second.ready;
  const { notes } = await second.requests.noteList({ root });
  expect(notes.map((n) => n.title)).toContain("Written While Away");
});

// Two daemons on one app home would be two servers owning one set of notes,
// two watcher pairs per root, and two writers racing every atomic rename. The
// socket file is the interlock, and a LIVE one is left alone.
test("a second daemon on the same socket refuses to start", async () => {
  const { socketPath, pidPath } = await daemonIn();
  await expect(startDaemon({ socketPath, pidPath, idleMs: 1000 })).rejects.toThrow();
});
