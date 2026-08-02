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
import { clientConnection } from "./transport";
import { BUILD_VERSION } from "../shared/version";
import { PUSH_MESSAGES } from "../shared/wire";
import type { ServerPush } from "./server";

const push = Object.fromEntries(PUSH_MESSAGES.map((m) => [m, () => {}])) as unknown as ServerPush;

const started: Daemon[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const d of started.splice(0)) d.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function daemonIn(opts: { idleMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ledge-daemon-unit-"));
  dirs.push(dir);
  const socketPath = join(dir, "server.sock");
  const pidPath = join(dir, "server.pid");
  const d = await startDaemon({ socketPath, pidPath, idleMs: opts.idleMs ?? 60_000, build: BUILD_VERSION });
  started.push(d);
  return { d, socketPath, pidPath };
}

const connect = async (socketPath: string, who: string) => {
  const duplex = await connectToDaemon({ socketPath, spawn: () => {}, timeoutMs: 2000 });
  return clientConnection(duplex, { push, build: BUILD_VERSION, client: who });
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
