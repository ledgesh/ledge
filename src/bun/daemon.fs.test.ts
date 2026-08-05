// The server as a process, over a real unix socket (remote.md §1).
//
// serve.fs.test.ts proves the assembly from outside — two processes, an actual
// `bun serve.ts serve`, a run that outlives its client. This proves the rules
// that assembly cannot easily provoke: what two clients on one daemon each get
// sent, which connection a third one replaces, and when a daemon nobody is
// using decides to stop.
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
import { closeWatchers } from "./watch";
import { clientConnection } from "../shared/transport";
import { BUILD_VERSION } from "../shared/version";
import { PUSH_MESSAGES, type ServerPush } from "../shared/wire";
import type { RunEvent } from "../shared/rpc-schema";

const push = Object.fromEntries(PUSH_MESSAGES.map((m) => [m, () => {}])) as unknown as ServerPush;

/** Every push one client was sent, in order. The routing rules are entirely
 * about which of these arrive where, so the tests below read the record rather
 * than watching for one message and hoping. */
type Seen = Array<{ m: string; p: unknown }>;
const record = (seen: Seen): ServerPush =>
  Object.fromEntries(PUSH_MESSAGES.map((m) => [m, (p: unknown) => void seen.push({ m, p })])) as unknown as ServerPush;
const got = <T>(seen: Seen, m: string): T[] => seen.filter((e) => e.m === m).map((e) => e.p as T);

const b64 = (text: string) => Buffer.from(text).toString("base64");
const decode = (chunks: Array<{ dataB64: string }>) => chunks.map((c) => Buffer.from(c.dataB64, "base64").toString()).join("");

// Comfortably inside bun's per-test timeout, so a rule that broke reports as
// the assertion that failed rather than as a test that ran out of time.
const until = async (cond: () => boolean, ms = 3_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

const started: Daemon[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const d of started.splice(0)) d.stop();
  // The watcher registry is a module singleton and holds the FIRST server's
  // callback for a root (bun/watch.ts), so without this every daemon after the
  // first in this file would push its notesChanged into a dead one's closure.
  closeWatchers();
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

const connect = async (socketPath: string, who: string, opts: { hold?: number; seen?: Seen } = {}) => {
  const duplex = await connectToDaemon({ socketPath, spawn: () => {}, timeoutMs: 2000 });
  return clientConnection(duplex, {
    push: opts.seen ? record(opts.seen) : push,
    build: BUILD_VERSION,
    client: who,
    ...(opts.hold === undefined ? {} : { hold: opts.hold }),
  });
};

/** A connected client and everything it has been pushed since. */
const joined = async (socketPath: string, who: string) => {
  const seen: Seen = [];
  const conn = await connect(socketPath, who, { seen });
  await conn.ready;
  return { conn, seen };
};

describe("several clients at once", () => {
  // The ordinary shape of this is a Mac and a phone pointed at one machine, and
  // the daemon used to answer it by hanging up on one of them. Almost nothing
  // needed a rule: a note is a note whoever asked for it.
  test("two clients are both served", async () => {
    const { socketPath } = await daemonIn();
    const mac = await connect(socketPath, "mac-1");
    await mac.ready;

    const phone = await connect(socketPath, "phone-1");
    await phone.ready;

    expect(await phone.requests.vaultState({})).toBeDefined();
    // The one that was already here is untouched: still answering, and never
    // told anything about a goodbye.
    expect(await mac.requests.vaultState({})).toBeDefined();
    expect(mac.farewell()).toBe(null);
  });

  // What is left of displacement, doing the job it was always doing
  // underneath: what a reconnect reconnects PAST is a half-open wire nobody
  // has noticed is dead, and the new connection takes it over rather than
  // fighting it. Same client id, so no other device's session is at stake.
  test("a client's second connection replaces its own first, and says why", async () => {
    const { socketPath } = await daemonIn();
    const first = await connect(socketPath, "mac-1");
    await first.ready;
    const second = await connect(socketPath, "mac-1");
    await second.ready;

    await first.closed; // resolves, rather than hanging: it was hung up on
    // A `bye` with a reason, not a silent hangup: without it the replaced end
    // sees only a closed pipe and cannot tell being taken over from the server
    // dying (wire.ts). And the reason survives as a REASON rather than only as
    // an error message, because the ladder reads it to tell a server that
    // decided from a wire that broke (shared/transport.ts).
    await expect(first.requests.vaultState({})).rejects.toThrow("this client opened another connection");
    expect(first.farewell()).toBe("this client opened another connection to this server");
    expect(await second.requests.vaultState({})).toBeDefined();
  });

  // The rule is about clients, and a socket that has not said who it is is not
  // one yet. This is exactly what clearStaleSocket does to decide whether a
  // daemon is behind a socket file — connect, then hang up — so on the accept
  // rather than on the hello it would count as somebody using the server.
  test("a socket that never says who it is takes nothing from the client that did", async () => {
    const { socketPath, pidPath } = await daemonIn();
    const client = await connect(socketPath, "mac-1");
    await client.ready;

    await expect(startDaemon({ socketPath, pidPath, idleMs: 1000 })).rejects.toThrow();

    expect(await client.requests.vaultState({})).toBeDefined();
    expect(client.farewell()).toBe(null);
  });
});

// Two clients make "send this" an incomplete instruction, so every push says
// who it is for (bun/server.ts Audience). The rules are not uniform and cannot
// be: what a note list needs everyone to know, a run event needs exactly one
// client to know.
describe("every push is addressed", () => {
  // Broadcast: a file that moved moved for everybody, and a client that was not
  // told has a stale note list until something else happens to that root.
  // Driven through the REAL watcher, since that is the only thing that sends
  // this one.
  test("a file that changed reaches every client", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const mac = await joined(socketPath, "mac-1");
    const phone = await joined(socketPath, "phone-1");
    const { workspaces } = await mac.conn.requests.workspaceList({});
    const root = workspaces[0]!.root;

    await Bun.write(join(root, "changed-under-both.md"), "# Changed Under Both\n");

    expect(await until(() => got(mac.seen, "notesChanged").length > 0)).toBe(true);
    expect(await until(() => got(phone.seen, "notesChanged").length > 0)).toBe(true);
  });

  // Broadcast, for the same reason and a sharper one: the vault is the
  // server's, so unlocking it on the Mac unlocks the phone's locked notes too.
  // A phone still drawing a padlock over a note it can now read would be
  // showing the wrong machine's state.
  test("the vault's state reaches every client", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const mac = await joined(socketPath, "mac-1");
    const phone = await joined(socketPath, "phone-1");

    await mac.conn.requests.vaultLock({});

    expect(await until(() => got(phone.seen, "vaultChanged").length > 0)).toBe(true);
    expect(got(mac.seen, "vaultChanged").length).toBe(1);
  });

  // Addressed: a run event is keyed by a run id, and the only thing that can do
  // anything with that id is the panel that minted it. Anywhere else it is an
  // event about a block that is not on screen.
  test("a block's output reaches the client that ran it and nobody else", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const mac = await joined(socketPath, "mac-1");
    const phone = await joined(socketPath, "phone-1");

    await mac.conn.requests.runBlock({ sessionId: "note-1", id: "run-1", code: "echo ran-it", language: "sh" });

    expect(await until(() => got<RunEvent>(mac.seen, "runEvent").some((ev) => ev.kind === "ended"))).toBe(true);
    expect(got(phone.seen, "runEvent")).toEqual([]);
  });

  // Addressed, and the busy flag beside it is not: bytes belong to whoever has
  // the drawer open, but busy grays out the terminal button on any client with
  // that note open. Through a real PTY, because what has to be true is that the
  // shell's own output goes one way and not the other.
  test("a drawer's bytes reach the client watching it, and the busy flag reaches both", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const mac = await joined(socketPath, "mac-1");
    const phone = await joined(socketPath, "phone-1");

    await mac.conn.requests.terminalAttach({ sessionId: "note-1" });
    // The shell's first prompt, before typing into it. A cold shell is
    // deliberately not "busy" (bun/server.ts everReady), and input written
    // before zsh's line editor exists is echoed by the tty and read later, so
    // the whole prompt cycle lands in one drain tick and no busy edge exists to
    // observe. Bracketed paste on is the signal, as it is for the paste queue.
    expect(await until(() => decode(got(mac.seen, "terminalOutput")).includes("\x1b[?2004h"))).toBe(true);
    // And long enough to be observably mid-job: busy is sampled on an 8ms drain
    // tick, and an `echo` is over before the tick that would have reported it.
    await mac.conn.requests.terminalInput({ sessionId: "note-1", dataB64: b64("sleep 0.4; echo from-the-mac\n") });
    expect(await until(() => decode(got(mac.seen, "terminalOutput")).includes("from-the-mac"))).toBe(true);
    expect(got(phone.seen, "terminalOutput")).toEqual([]);
    expect(await until(() => got(phone.seen, "terminalBusy").length > 0)).toBe(true);

    // The last to attach takes it. #104 turns this into an owner with watchers,
    // gives the taking a button, and tells the client it was taken from; today
    // the bytes simply follow the latest attach.
    await phone.conn.requests.terminalAttach({ sessionId: "note-1" });
    const macSoFar = got(mac.seen, "terminalOutput").length;
    await phone.conn.requests.terminalInput({ sessionId: "note-1", dataB64: b64("echo from-the-phone\n") });
    expect(await until(() => decode(got(phone.seen, "terminalOutput")).includes("from-the-phone"))).toBe(true);
    expect(got(mac.seen, "terminalOutput").length).toBe(macSoFar);
  });

  // Closing a drawer says nothing about anybody else's. Without the check the
  // phone's detach would stop the bytes reaching the Mac, whose terminal would
  // go quiet with nothing on screen to explain it.
  test("one client detaching leaves another client's drawer alone", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const mac = await joined(socketPath, "mac-1");
    const phone = await joined(socketPath, "phone-1");

    await mac.conn.requests.terminalAttach({ sessionId: "note-1" });
    await phone.conn.requests.terminalDetach({ sessionId: "note-1" });

    await mac.conn.requests.terminalInput({ sessionId: "note-1", dataB64: b64("echo still-here\n") });
    expect(await until(() => decode(got(mac.seen, "terminalOutput")).includes("still-here"))).toBe(true);
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

  // "Its last client", now that there can be more than one: the one that leaves
  // takes nothing with it but its own connection.
  test("one client leaving does not end the daemon the other is using", async () => {
    const { d, socketPath } = await daemonIn({ idleMs: 200 });
    const mac = await connect(socketPath, "mac-1");
    const phone = await connect(socketPath, "phone-1");
    await mac.ready;
    await phone.ready;

    mac.close();
    const raced = await Promise.race([d.done.then(() => "exited"), new Promise((r) => setTimeout(() => r("still up"), 600))]);
    expect(raced).toBe("still up");
    expect(await phone.requests.vaultState({})).toBeDefined();

    phone.close();
    await d.done; // and the last one leaving does end it
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
// idle window it outlasts, or the two are indistinguishable and the test proves
// nothing about which one was used.
describe("a client that said it is coming back", () => {
  // iOS suspends an app shortly after it leaves the foreground and its socket
  // dies with it (ios.md §5), so on a phone "no client" is the ordinary state
  // of a connection that is still wanted. What the ask buys is the one thing
  // `running()` is right to ignore: a shell sitting at a prompt.
  test("keeps an idle session past the window that would have ended it", async () => {
    const { d, socketPath } = await daemonIn({ idleMs: 150, holdMs: 5_000 });
    const client = await connect(socketPath, "phone-1", { hold: 700 });
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
    const client = await connect(socketPath, "phone-1", { hold: 60_000 });
    await client.ready;
    client.close();
    await d.done; // on the ordinary window, rather than the minute it asked for
  });

  // The other half of asking: the answer is not the client's to give, so an
  // ask nobody would wait through is clamped rather than refused.
  test("an absurd ask is answered with the server's own ceiling", async () => {
    const { d, socketPath } = await daemonIn({ idleMs: 150, holdMs: 400 });
    const client = await connect(socketPath, "phone-1", { hold: 60 * 60_000 });
    await client.ready;
    await client.requests.terminalAttach({ sessionId: "note-1" });
    client.close();
    await d.done; // in 400ms, rather than the hour
  });

  // With several clients, the last one to leave is not necessarily the one that
  // asked. A phone backgrounds (ios.md §5) while a Mac stays connected, and the
  // Mac quits a moment later: the phone's five minutes must not become the
  // Mac's sixty seconds for that reason alone. So a hold is recorded as a
  // DEADLINE when its own connection ends, rather than read off whoever happens
  // to turn the lights out.
  test("a hold outlives the client that leaves before the last one does", async () => {
    const { d, socketPath } = await daemonIn({ idleMs: 150, holdMs: 5_000 });
    const phone = await connect(socketPath, "phone-1", { hold: 700 });
    await phone.ready;
    await phone.requests.terminalAttach({ sessionId: "note-1" });
    const mac = await connect(socketPath, "mac-1"); // asks for nothing
    await mac.ready;

    phone.close();
    await new Promise((r) => setTimeout(r, 100));
    mac.close();

    const raced = await Promise.race([
      d.done.then(() => "exited"),
      new Promise((r) => setTimeout(() => r("still up"), 400)),
    ]);
    expect(raced).toBe("still up"); // the Mac's 150ms window would have ended it
    await d.done; // and the phone's 700ms still does
  });
});

describe("runs the client that started them can no longer show", () => {
  // A run event is a push keyed by a run id, so a page that reloaded knows
  // none of them: the run would go on executing, hold the daemon under it, and
  // have no id left anywhere to stop it by. The claim at the next boot is what
  // collects it (rpc-schema inlineClaim). Driven through a real PTY, because
  // what has to be true is that the shell's foreground job actually dies.
  const watching = async (socketPath: string, who: string) => {
    const { conn, seen } = await joined(socketPath, who);
    return { conn, runs: () => got<RunEvent>(seen, "runEvent") };
  };

  test("a fresh page claims nothing, and the run it never learned about stops", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const first = await watching(socketPath, "phone-1");
    expect((await first.conn.requests.runBlock({ sessionId: "note-1", id: "run-1", code: "sleep 30", language: "sh" })).accepted).toBe(true);
    expect(await until(() => first.runs().some((ev) => ev.kind === "began"))).toBe(true);
    first.conn.close();

    // The page came back with no panels, so it names no runs.
    const next = await watching(socketPath, "phone-1");
    expect(await next.conn.requests.inlineClaim({ ids: [] })).toEqual({ running: [], orphaned: 1 });
    // 130 is the shell reporting the interrupt itself: the job died, and the
    // note's shell lived to say so.
    expect(await until(() => next.runs().some((ev) => ev.kind === "ended"))).toBe(true);
    expect(next.runs().find((ev) => ev.kind === "ended")).toEqual({ id: "run-1", kind: "ended", exitCode: 130 });
  });

  test("a run the client still shows is confirmed and left running", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const client = await watching(socketPath, "mac-1");
    await client.conn.requests.runBlock({ sessionId: "note-1", id: "run-1", code: "sleep 30", language: "sh" });
    expect(await until(() => client.runs().some((ev) => ev.kind === "began"))).toBe(true);

    // The wire flapped, the panel survived: the claim is what tells the server
    // this run still has somewhere to be seen.
    expect(await client.conn.requests.inlineClaim({ ids: ["run-1"] })).toEqual({ running: ["run-1"], orphaned: 0 });
    await new Promise((r) => setTimeout(r, 200));
    expect(client.runs().some((ev) => ev.kind === "ended")).toBe(false);
  });

  test("a run the server already finished is simply not confirmed", async () => {
    const { socketPath } = await daemonIn({ idleMs: 60_000 });
    const client = await watching(socketPath, "mac-1");
    await client.conn.requests.runBlock({ sessionId: "note-1", id: "run-1", code: "true", language: "sh" });
    expect(await until(() => client.runs().some((ev) => ev.kind === "ended"))).toBe(true);

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
