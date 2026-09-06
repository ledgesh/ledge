// The client ids against a real filesystem: the machine id, the id per
// connection, and parseClientMap. The server files this client's layout under
// the id this client sends (remote.md §5). A relaunch must report the same
// ids, and a read must never replace a well-formed one. A re-mint does not
// fail: it silently orphans the saved arrangement.
//
// Same preload-scratch-home arrangement and same guard as layout.fs.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { APP_HOME } from "./workspaces";
import {
  CLIENT_HOME,
  CLIENT_ID_PATH,
  CLIENT_MAP_PATH,
  clientId,
  clientIdFor,
  ensureClientHome,
  ephemeralClientId,
  forgetClientId,
  isClientId,
  parseClientMap,
} from "./clientHome";
import { LOCAL_ID } from "./connections";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

// clientId caches for the life of the process, so it can be called
// meaningfully only once here: the first test below, which mints an id. The
// second then checks that the cache answers that same id. A case added later
// must not call it again. To see the file, a case reads and writes
// CLIENT_ID_PATH itself or asks a fresh process what a launch sees.
describe("the client id", () => {
  beforeEach(async () => {
    await rm(APP_HOME, { recursive: true, force: true });
    await mkdir(APP_HOME, { recursive: true });
  });

  test("is minted on first launch and written where a relaunch will find it", async () => {
    const id = await clientId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readFile(CLIENT_ID_PATH, "utf8")).trim()).toBe(id);
  });

  test("the same call answers the same id, without re-reading", async () => {
    expect(await clientId()).toBe(await clientId());
  });

  // The id a launch reports is the id the launch before it reported. The
  // server's layout map depends on that. In-process the answer is cached, so
  // this asks two real processes.
  test("a relaunch reports the id the first launch minted", async () => {
    const first = await mintInFreshProcess();
    expect(isClientId(first)).toBe(true);
    expect(await mintInFreshProcess()).toBe(first);
  });

  test("the client home is inside the app home, so one scratch root moves both", () => {
    expect(resolve(CLIENT_HOME).startsWith(resolve(APP_HOME) + sep)).toBe(true);
    expect(resolve(CLIENT_ID_PATH).startsWith(resolve(CLIENT_HOME) + sep)).toBe(true);
  });

  test.each([["", "empty"], ["\n", "a bare newline"], ["not-a-uuid", "hand-edited text"], ["0000", "a truncated write"]])(
    "%p (%s) is not read as an id",
    (junk) => {
      expect(isClientId(junk.trim())).toBe(false);
    },
  );

  // A garbage id file has to be replaced, not just rejected. Leaving it in
  // place would mint a fresh id at every launch and orphan the saved layout
  // each time. The file is one line of text in a folder people back up and
  // sync, so half-written content is realistic. Run through a fresh process
  // because the read happens once per process and is cached after.
  test("a garbage id file is replaced with a real one, once", async () => {
    await ensureClientHome();
    await writeFile(CLIENT_ID_PATH, "half a wri", "utf8");
    const first = await mintInFreshProcess();
    expect(isClientId(first)).toBe(true);
    expect((await readFile(CLIENT_ID_PATH, "utf8")).trim()).toBe(first);
    // The launch after that reads the replacement rather than minting again.
    expect(await mintInFreshProcess()).toBe(first);
  });
});

// The per-connection ids, now that a window is a client and identity follows
// the connection (remote.md §8a). Selecting a server again brings back the
// arrangement it has on file. That holds only while the id this client sends
// it stays the same. These run in-process: the map cache is mutable through
// this module, so unlike the id above there is nothing to reach past.
describe("the id per connection", () => {
  beforeEach(async () => {
    await rm(APP_HOME, { recursive: true, force: true });
    await mkdir(APP_HOME, { recursive: true });
    // The cache is per process and these cases share one. Forgetting both ids
    // this file uses is what makes each case start from an empty map.
    await forgetClientId("vps-1");
    await forgetClientId("laptop-1");
  });

  test("the local server's id is the machine id, so an upgrade keeps its layout", async () => {
    expect(await clientIdFor(LOCAL_ID)).toBe(await clientId());
  });

  test("a connection gets its own id, minted once and answered the same every time", async () => {
    const first = await clientIdFor("vps-1");
    expect(isClientId(first)).toBe(true);
    expect(await clientIdFor("vps-1")).toBe(first);
    expect(JSON.parse(await readFile(CLIENT_MAP_PATH, "utf8"))["vps-1"]).toBe(first);
  });

  // A layout is three panes of one machine's notes and means nothing in front
  // of another machine's. That is why each connection gets its own id.
  test("two connections are two clients", async () => {
    expect(await clientIdFor("vps-1")).not.toBe(await clientIdFor("laptop-1"));
    expect(await clientIdFor("vps-1")).not.toBe(await clientIdFor(LOCAL_ID));
  });

  // One entry per connection is all the file ever holds. connectionStore.ts
  // remove drops the entry along with the connection.
  test("forgetting a connection drops its id, and the next one is fresh", async () => {
    const first = await clientIdFor("vps-1");
    await forgetClientId("vps-1");
    expect(JSON.parse(await readFile(CLIENT_MAP_PATH, "utf8"))["vps-1"]).toBeUndefined();
    expect(await clientIdFor("vps-1")).not.toBe(first);
  });

  test("forgetting one this client never had is not an error", async () => {
    await forgetClientId("never-connected");
  });

  // The second window on a server is a client that server has never met, for
  // as long as that window is open. Its id is never written down.
  test("an ephemeral id is a real id and is not stored", async () => {
    const one = ephemeralClientId();
    expect(isClientId(one)).toBe(true);
    expect(one).not.toBe(ephemeralClientId());
    await clientIdFor("vps-1");
    expect(Object.values(JSON.parse(await readFile(CLIENT_MAP_PATH, "utf8")))).not.toContain(one);
  });

  // The id a launch sends a server is the id the launch before it sent that
  // server, and it is that server's id rather than the machine's. Asked of two
  // real processes, because the map is cached within each one.
  test("a relaunch reports the ids the launch before it minted, one per connection", async () => {
    const first = await mapInFreshProcess();
    expect(isClientId(first["vps-1"]!)).toBe(true);
    expect(first["vps-1"]).not.toBe(first["laptop-1"]);
    expect(first["vps-1"]).not.toBe(first["local"]);
    expect(await mapInFreshProcess()).toEqual(first);
  });
});

describe("parseClientMap", () => {
  test("well-formed entries survive", () => {
    const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(parseClientMap({ "vps-1": id })).toEqual({ "vps-1": id });
  });

  // Machine-written state (architecture.md §6). A bad entry costs only itself,
  // and a value that is not an object at all yields no ids. The rows below are
  // both kinds. A file whose JSON does not parse is caught in clientMap
  // instead, and costs the same: saved arrangements, never the launch.
  test.each([
    [null, "null"],
    ["nope", "a string"],
    [[1, 2], "an array"],
    [{ "vps-1": 7 }, "a number for an id"],
    [{ "vps-1": "not-a-uuid" }, "a hand-edited id"],
    [{ "": "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }, "an empty connection id"],
  ])("%p (%s) contributes nothing", (raw) => {
    expect(parseClientMap(raw)).toEqual({});
  });

  // The local server's id lives in its own file, so an entry under that key
  // could only shadow it.
  test("an entry claiming the local id is dropped", () => {
    expect(parseClientMap({ [LOCAL_ID]: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" })).toEqual({});
  });
});

// Each call spawns a whole `bun -e`, because the question is what a launch
// sees and a launch is a process. The child gets LEDGE_NOTES_ROOT set to
// APP_HOME, the preload's scratch home, so it reads and writes the same files
// the test does.
async function mintInFreshProcess(): Promise<string> {
  const p = Bun.spawn(
    [process.execPath, "-e", `import { clientId } from "${resolve(import.meta.dir, "clientHome.ts")}"; console.log(await clientId())`],
    { env: { ...process.env, LEDGE_NOTES_ROOT: APP_HOME }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return out.trim();
}

// The same question about the per-connection map. Each call asks one fresh
// process for three ids: two connections and the local server.
async function mapInFreshProcess(): Promise<Record<string, string>> {
  const src = resolve(import.meta.dir, "clientHome.ts");
  const p = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { clientIdFor } from "${src}";
       console.log(JSON.stringify({
         "vps-1": await clientIdFor("vps-1"),
         "laptop-1": await clientIdFor("laptop-1"),
         local: await clientIdFor("local"),
       }))`,
    ],
    { env: { ...process.env, LEDGE_NOTES_ROOT: APP_HOME }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return JSON.parse(out.trim());
}
