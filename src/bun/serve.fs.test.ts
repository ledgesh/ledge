// The spawned-process seam: the actual `bun src/bun/serve.ts` an ssh session
// would launch, spoken to over its real stdin and stdout by the real client
// end. transport.test.ts proves the conversation and wire.test.ts the codec;
// what only this can prove is the assembly — `serve` finds or starts this
// machine's daemon, the daemon boots createServer with no window attached, the
// handlers answer through the frame codec across two process boundaries,
// NOTHING but frames reaches stdout, and the §2 guards refuse a request that
// arrived over a pipe exactly as they refuse one that arrived in-process
// (remote.md §13).
//
// The child gets its own scratch home, built by hand: it is a separate
// process, so the preload's root does not reach it, and writing the registry
// file directly is what "the app ran here earlier" looks like to a server.
// The daemon it starts lives in that home too, which is what makes killing it
// afterwards safe — nothing here can reach the real one.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_FRAME, encodeControl, FRAME_HEADER_BYTES, FrameDecoder, hello, parseControl, type ServerPush } from "../shared/wire";
import { BUILD_VERSION } from "../shared/version";
import { clientConnection, type ClientConnection } from "../shared/transport";
import { spawnDuplex } from "./transport";
import type { NoteMeta, WorkspaceRootInfo } from "../shared/rpc-schema";

const SERVE = join(import.meta.dir, "serve.ts");
const HOME = await mkdtemp(join(tmpdir(), "ledge-serve-"));
const WS = join(HOME, "ws");

const pushes: Array<[string, unknown]> = [];
const push = new Proxy({}, { get: (_t, m: string) => (p: unknown) => pushes.push([m, p]) }) as ServerPush;

let client: ClientConnection;

/** The daemon outlives the `serve` that started it — that is the whole point
 * (remote.md §7) — so a test that starts one has to stop it, or it sits on a
 * deleted scratch home until its idle timer fires a minute later. */
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

// The invariant that keeps "the client is the least-trusted end" honest: the
// transport changed, the guard did not, and its refusal is what the caller
// gets rather than a file.
test("a path outside the workspace roots is refused over the wire", async () => {
  await expect(client.requests.noteRead({ path: join(HOME, "..", ".ssh", "id_rsa") })).rejects.toThrow();
  await expect(client.requests.noteWrite({ path: "/etc/hosts", text: "x", baseMtimeMs: null })).rejects.toThrow();
});

// Absent is not the same as cancelled: a headless server says why there is no
// dialog instead of answering the way a dismissed one would (remote.md §5).
test("a headless server refuses to attach a folder, with a reason", async () => {
  const res = (await client.requests.workspaceAttach({})) as { root: string | null; error: string | null };
  expect(res.root).toBeNull();
  expect(res.error).toContain("headless server");
});

// The same shape one verb over. A server has no CLI to put on its PATH: the
// shim execs the runtime and entry that wrote it, and there is no cli.js beside
// this module in a checkout any more than there is one inside a compiled
// `ledge-server`. The answer rides the boot handshake so the palette can leave
// the verb out (mainview/lib/shell.ts), and the call refuses in a sentence
// rather than with the shim's "the CLI entry is missing at …", which names a
// path no user has ever seen and tells them to rebuild the app.
test("a server has no CLI to install, and says so on the handshake and again if asked", async () => {
  const { cliShim } = (await client.requests.workspaceList({})) as { cliShim: boolean };
  expect(cliShim).toBe(false);
  const res = (await client.requests.cliInstall({})) as { ok: boolean; message: string };
  expect(res.ok).toBe(false);
  expect(res.message).toContain("no CLI to install");
});

// The other half of remote.md §10, and the reason the refusals are throws: a
// server that answered `{text: ""}` here would look exactly like an empty
// clipboard, and the bug would live in whatever the user pasted next. The real
// client never gets this far — bun/index.ts overlays clientSeams over every
// connection — so this is the assertion that the overlay is load-bearing.
test("the clipboard and the browser are not the server's to answer", async () => {
  await expect(client.requests.clipboardRead({})).rejects.toThrow("remote.md §10");
  await expect(client.requests.clipboardReadRich({})).rejects.toThrow("remote.md §10");
  await expect(client.requests.clipboardWrite({ text: "x" })).rejects.toThrow("remote.md §10");
  await expect(client.requests.linkOpen({ url: "https://example.com" })).rejects.toThrow("remote.md §10");
  await expect(client.requests.menuSet({ items: [] })).rejects.toThrow("remote.md §10");
});

// A separate process on purpose, and its own home: this one's stdout is
// captured raw rather than decoded by a connection, so a stray log line has
// somewhere to show up. One byte of one would desynchronize every session
// above, which is why the rule gets a test rather than the benefit of the
// doubt. The legacy settings.json seeded below is there to GUARANTEE the boot
// path console.logs something, since a log that never happens proves nothing
// about where logs go.
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

  await drain(() => heard.length >= 2);
  // Only now: closing stdin is a hangup, and a server is right to drop the
  // answer it was about to write to a client that has gone.
  await proc.stdin.end();
  await drain(() => false);

  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);

  // Every byte that came out of stdout was inside a frame. A single logged
  // line, or a partial frame at the end, breaks this equality.
  expect(onStdout).toBe(insideFrames);
  expect(heard[0]).toMatchObject({ t: "hello", role: "server" });
  expect(heard).toContainEqual({ t: "res", id: 1, r: { state: "none" } });

  expect(err).toContain("[serve] ledge-server");
  // console.log rerouted rather than dropped: a server nobody can hear is its
  // own kind of bug. It lands in the DAEMON's log now, not on this process's
  // stderr — `serve` is a byte pump and the boot happened one process over
  // (remote.md §1).
  expect(await readFile(join(home, "logs", "ledge-server.log"), "utf8")).toContain("[settings] migrated");

  await stopDaemon(home);
  await rm(home, { recursive: true, force: true });
});

// The socket, the pid file, and the promise that a run outlives its client
// (remote.md §7). Everything above talks THROUGH a connection; this is about
// what is still there when one goes away.
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
  // The same process, not a fresh one: a second `serve` attaches, it does not
  // start a rival.
  expect(Number((await readFile(join(home, ".server.pid"), "utf8")).trim())).toBe(pid);
  second.close();

  await stopDaemon(home);
  await rm(home, { recursive: true, force: true });
});
