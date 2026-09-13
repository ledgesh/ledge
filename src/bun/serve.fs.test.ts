// The spawned-process seam: `serve.ts` in a process of its own, driven over
// its real stdin and stdout by the real client end. An ssh session launches
// the compiled `ledge serve`, which is this same entry (remote.md §1).
// transport.test.ts covers the conversation and wire.test.ts the codec. Only
// this covers the assembly: the daemon `serve` finds or starts, headless
// handlers answering through the frame codec across two process boundaries,
// stdout carrying frames and nothing else, and the §2 guards refusing over a
// pipe as they refuse in-process (remote.md §13).

// The child gets its own scratch home, written by hand. It is a separate
// process, so the preload's root does not reach it, and a registry file on
// disk is what "the app ran here earlier" looks like to a server. The daemon
// it starts lives in that home too, so nothing here can reach the real one.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_FRAME, encodeControl, FRAME_HEADER_BYTES, FrameDecoder, hello, parseControl, type ServerPush } from "../shared/wire";
import { BUILD_VERSION } from "../shared/version";
import { clientConnection, type ClientConnection } from "../shared/transport";
import { spawnDuplex } from "./transport";
import { daemonPid, retireDaemon, stopDaemon as daemonStop } from "./daemon";
import type { NoteMeta, WorkspaceRootInfo } from "../shared/rpc-schema";

const SERVE = join(import.meta.dir, "serve.ts");
const HOME = await mkdtemp(join(tmpdir(), "ledge-serve-"));
const WS = join(HOME, "ws");

const pushes: Array<[string, unknown]> = [];
const push = new Proxy({}, { get: (_t, m: string) => (p: unknown) => pushes.push([m, p]) }) as ServerPush;

let client: ClientConnection;

/** Stop the daemon a test started. The daemon outlives the `serve` that
 * started it (remote.md §7), so one left behind sits on a deleted scratch home
 * until its idle timer fires a minute later (daemon.ts, IDLE_EXIT_MS). */
async function stopDaemon(home: string): Promise<void> {
  try {
    const pid = Number((await readFile(join(home, ".server.pid"), "utf8")).trim());
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
  } catch {
    // Already gone, or never started.
  }
}

beforeAll(async () => {
  await mkdir(WS, { recursive: true });
  await writeFile(join(HOME, ".workspaces.json"), JSON.stringify({ version: 1, roots: [WS] }));
  await writeFile(join(WS, "over-the-wire.md"), "# Over The Wire\n\nsecret word: xyzzy\n");
  client = clientConnection(spawnDuplex([process.execPath, SERVE, "serve"], { env: { LEDGE_NOTES_ROOT: HOME } }), {
    push,
    build: BUILD_VERSION,
  });
});

afterAll(async () => {
  client?.close();
  await stopDaemon(HOME);
  await rm(HOME, { recursive: true, force: true });
});

test("the server greets with its build and the schema both ends agree on", async () => {
  const peer = await client.ready;
  expect(peer.role).toBe("server");
  expect(peer.build).toBe(BUILD_VERSION);
});

test("the registry the server booted from comes back over the wire", async () => {
  const { workspaces } = (await client.requests.workspaceList({})) as { workspaces: WorkspaceRootInfo[] };
  expect(workspaces.map((w) => w.root)).toContain(WS);
});

test("a note seeded on disk is listed and read through the connection", async () => {
  const { notes } = (await client.requests.noteList({ root: WS })) as { notes: NoteMeta[] };
  const seeded = notes.find((n) => n.title === "Over The Wire");
  expect(seeded).toBeDefined();
  const { note } = (await client.requests.noteRead({ path: seeded!.path })) as {
    note: { text: string; mtimeMs: number } | null;
  };
  expect(note?.text).toContain("secret word: xyzzy");
});

test("a note created over the connection lands on disk under its own heading", async () => {
  const { note } = (await client.requests.noteCreate({ root: WS, text: "# Wired Up\n\nbody\n" })) as {
    note: NoteMeta;
  };
  expect(note.path).toBe(join(WS, "wired-up.md"));
  expect(await Bun.file(note.path).text()).toBe("# Wired Up\n\nbody\n");
});

// The path guards refuse over the wire as they refuse in-process (remote.md
// §2). The transport changed and the guard did not: the caller gets the
// refusal rather than the file.
test("a path outside the workspace roots is refused over the wire", async () => {
  await expect(client.requests.noteRead({ path: join(HOME, "..", ".ssh", "id_rsa") })).rejects.toThrow();
  await expect(client.requests.noteWrite({ path: "/etc/hosts", text: "x", baseMtimeMs: null })).rejects.toThrow();
});

// A folder is attached by its path on the server (remote.md §5): the one
// string a client sends that is not a handle it was given. The server checks
// it, so a refusal is a sentence in `error` and never a root.
test("a folder attaches by its path on the server, and a bad path is refused with a reason", async () => {
  // Beside the app home, not under it: a direct child of the app home is a
  // managed folder (bun/workspaces.ts kindOf).
  const folder = await mkdtemp(join(tmpdir(), "ledge-typed-"));
  const res = await client.requests.workspaceAttach({ path: folder });
  expect(res).toEqual({ root: folder, kind: "external", error: null });
  const bad = (await client.requests.workspaceAttach({ path: "typed" })) as { root: string | null; error: string | null };
  expect(bad.root).toBeNull();
  expect(bad.error).toContain("not an absolute path");
});

// Deleting a workspace needs no dialog, so a headless server does all of it:
// the folder into its own trash, listed back, restored, then deleted for good.
// These are the handlers a phone's delete reaches (architecture.md §3).
test("a workspace deleted over the wire lands in the server's trash and restores whole", async () => {
  const { root } = (await client.requests.workspaceCreate({ name: "Wire Trash" })) as { root: string };
  await client.requests.noteCreate({ root, text: "# Survivor\n" });
  const trashed = (await client.requests.workspaceTrash({ root, name: "Wire Trash", symbol: "inbox" })) as {
    id: string | null;
    error: string | null;
  };
  expect(trashed).toEqual({ id: "wire-trash", error: null });
  const listed = (await client.requests.workspaceList({})) as { workspaces: WorkspaceRootInfo[] };
  expect(listed.workspaces.map((w) => w.root)).not.toContain(root);
  const { items } = await client.requests.workspaceTrashList({});
  expect(items).toContainEqual(expect.objectContaining({ id: "wire-trash", name: "Wire Trash", notes: 1 }));

  const back = await client.requests.workspaceTrashRestore({ id: "wire-trash" });
  expect(back).toEqual({ root, name: "Wire Trash", symbol: "inbox", error: null });
  expect(await Bun.file(join(root, "survivor.md")).text()).toBe("# Survivor\n");

  await client.requests.workspaceTrash({ root, name: "Wire Trash", symbol: "" });
  expect(await client.requests.workspaceTrashDelete({ id: "wire-trash" })).toEqual({ removed: true });
  expect(await Bun.file(join(root, "survivor.md")).exists()).toBe(false);
  await expect(client.requests.workspaceTrashDelete({ id: "../ws" })).rejects.toThrow("not a deleted workspace");
});

// The shell command is the client's to install (remote.md §10): the shims
// land on the machine with the screen and run its own copy (bun/cliShim.ts).
// The server refuses the call by name like the pasteboard's, and the
// handshake carries no fact about it: the CLI is a verb of every server.
test("the shell command is not the server's to install", async () => {
  await expect(client.requests.cliInstall({})).rejects.toThrow("remote.md §10");
  expect(Object.keys(await client.requests.workspaceList({})).sort()).toEqual(["dailyRoot", "workspaces"]);
});

// The other half of remote.md §10. The refusals throw because a server that
// answered `{text: ""}` would look like an empty clipboard, and the bug would
// show up in whatever got pasted next. The real client never reaches them:
// bun/index.ts wraps every connection's handlers in clientOverlay, so this
// test is the assertion that the overlay is load-bearing.
test("the clipboard and the browser are not the server's to answer", async () => {
  await expect(client.requests.clipboardRead({})).rejects.toThrow("remote.md §10");
  await expect(client.requests.clipboardReadRich({})).rejects.toThrow("remote.md §10");
  await expect(client.requests.clipboardWrite({ text: "x" })).rejects.toThrow("remote.md §10");
  await expect(client.requests.linkOpen({ url: "https://example.com" })).rejects.toThrow("remote.md §10");
  await expect(client.requests.menuSet({ items: [] })).rejects.toThrow("remote.md §10");
});

// This test reads stdout raw instead of decoding it through a connection, so
// a stray log line has somewhere to show up. It runs in its own process, with
// its own scratch home. One stray byte desynchronizes a length-prefixed
// stream with no way back, and every connection in this file rides one. The
// legacy settings.json seeded below makes the boot path log a line, so the
// log assertion at the end has something to find.
test("stdout carries frames and nothing else; the server's own logging is on stderr", async () => {
  const home = await mkdtemp(join(tmpdir(), "ledge-serve-stdout-"));
  const ws = join(home, "ws");
  await mkdir(ws, { recursive: true });
  await writeFile(join(home, ".workspaces.json"), JSON.stringify({ version: 1, roots: [ws] }));
  await writeFile(join(home, "settings.json"), "{}\n");

  const proc = Bun.spawn({
    cmd: [process.execPath, SERVE, "serve"],
    env: { ...process.env, LEDGE_NOTES_ROOT: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(encodeControl(hello("client", BUILD_VERSION)));
  proc.stdin.write(encodeControl({ t: "req", id: 1, m: "vaultState", p: {} }));
  proc.stdin.flush();

  const reader = proc.stdout.getReader();
  const decoder = new FrameDecoder();
  const encoder = new TextEncoder();
  const heard: unknown[] = [];
  let onStdout = 0;
  let insideFrames = 0;

  async function drain(until: () => boolean): Promise<void> {
    while (!until()) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value) continue;
      onStdout += value.length;
      for (const frame of decoder.push(value)) {
        expect(frame.type).toBe(CONTROL_FRAME);
        const text = frame.type === CONTROL_FRAME ? frame.text : "";
        insideFrames += FRAME_HEADER_BYTES + encoder.encode(text).length;
        heard.push(parseControl(text));
      }
    }
  }

  // Drain until the response, not until a frame count. A connection also
  // arrives to a presence push (bun/daemon.ts, announcePresence), so counting
  // frames would close stdin between that push and the response this test
  // reads.
  await drain(() => heard.some((m) => (m as { t: string }).t === "res"));
  // Only now: closing stdin is a hangup, and a server drops the answer it was
  // about to write to a client that has gone.
  await proc.stdin.end();
  await drain(() => false);

  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);

  // Every byte that came out of stdout was inside a frame. A single logged
  // line, or a partial frame at the end, breaks this equality.
  expect(onStdout).toBe(insideFrames);
  expect(heard[0]).toMatchObject({ t: "hello", role: "server" });
  expect(heard).toContainEqual({ t: "res", id: 1, r: { state: "none" } });

  expect(err).toContain("[serve] ledge ");
  // console.log is rerouted rather than dropped, because the server's own
  // diagnostics still have to be readable somewhere. The line lands in the
  // daemon's log, not on this process's stderr: `serve` is a byte pump and the
  // boot happened one process over (remote.md §1).
  expect(await readFile(join(home, "logs", "ledge-server.log"), "utf8")).toContain("[settings] migrated");

  await stopDaemon(home);
  await rm(home, { recursive: true, force: true });
});

// The socket, the pid file, and a run outliving its client (remote.md §7).
// Everything above talks through a connection. This test is about what is
// still there once one goes away.
test("the daemon outlives the connection that started it, and says where it is", async () => {
  const home = await mkdtemp(join(tmpdir(), "ledge-daemon-"));
  await mkdir(join(home, "ws"), { recursive: true });
  await writeFile(join(home, ".workspaces.json"), JSON.stringify({ version: 1, roots: [join(home, "ws")] }));

  const first = clientConnection(spawnDuplex([process.execPath, SERVE, "serve"], { env: { LEDGE_NOTES_ROOT: home } }), {
    push,
    build: BUILD_VERSION,
    client: "probe-1",
  });
  await first.ready;
  const pid = Number((await readFile(join(home, ".server.pid"), "utf8")).trim());
  expect(Number.isInteger(pid)).toBe(true);
  // Alive: signal 0 asks without sending anything.
  expect(() => process.kill(pid, 0)).not.toThrow();

  // Something only a surviving server could remember.
  await first.requests.layoutSave({ text: '{"kept":true}' });
  first.close();

  const second = clientConnection(spawnDuplex([process.execPath, SERVE, "serve"], { env: { LEDGE_NOTES_ROOT: home } }), {
    push,
    build: BUILD_VERSION,
    client: "probe-1",
  });
  await second.ready;
  expect(await second.requests.layoutGet({})).toEqual({ text: '{"kept":true}' });
  // The same process, not a fresh one: a second `serve` attaches to the
  // running daemon rather than starting another.
  expect(Number((await readFile(join(home, ".server.pid"), "utf8")).trim())).toBe(pid);
  second.close();

  await stopDaemon(home);
  await rm(home, { recursive: true, force: true });
});

// The two signals the Mac app sends a daemon of another build (daemon.ts
// `retireDaemon`, `stopDaemon`). Both go by the pid file, so they are proved
// against a daemon in a process of its own: the in-process tests can call
// `retireWhenIdle` directly, and this is the assertion that a signal reaches
// it.
test("the app can ask a daemon to retire, or stop it, by its pid file", async () => {
  const home = await mkdtemp(join(tmpdir(), "ledge-retire-"));
  await mkdir(join(home, "ws"), { recursive: true });
  await writeFile(join(home, ".workspaces.json"), JSON.stringify({ version: 1, roots: [join(home, "ws")] }));
  const pidPath = join(home, ".server.pid");
  const dialled = () =>
    clientConnection(spawnDuplex([process.execPath, SERVE, "serve"], { env: { LEDGE_NOTES_ROOT: home } }), {
      push,
      build: BUILD_VERSION,
      client: "probe-1",
    });

  const first = dialled();
  await first.ready;
  // Registered, and not only greeted: the presence push follows the
  // daemon's registration of this client (daemon.fs.test.ts says why).
  const heard = pushes.length;
  expect(await until(() => pushes.slice(heard).some(([m]) => m === "presence"))).toBe(true);
  const pid = daemonPid(pidPath);
  expect(pid).not.toBeNull();
  expect(retireDaemon(pidPath)).toBe(true);
  // Nothing running, so it goes now, and it says so in the client's own terms.
  await first.closed;
  expect(first.farewell()).toEqual({ why: "this server is shutting down", back: true });
  expect(await until(() => daemonPid(pidPath) === null)).toBe(true);

  // The next dial starts a fresh one, which is the other half of what an
  // update relies on.
  const second = dialled();
  await second.ready;
  expect(daemonPid(pidPath)).not.toBe(pid);
  expect(await daemonStop({ pidPath })).toBe(true);
  expect(daemonPid(pidPath)).toBeNull();
  second.close();

  await rm(home, { recursive: true, force: true });
});

const until = async (cond: () => boolean, ms = 3_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) await new Promise((r) => setTimeout(r, 20));
  return cond();
};
