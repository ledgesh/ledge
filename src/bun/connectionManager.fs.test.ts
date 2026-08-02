// Which server is being served, and what happens when that changes
// (remote.md §8). The manager is driven with a fake `attach`, so these run
// with no window, no socket, and no ssh binary — what is under test is the
// choreography, which is where the failures that matter live: a session torn
// down for a connection that was never going to open, a boot that refuses to
// draw because a laptop is asleep, a removed connection whose pin outlives it.
//
// Filesystem-backed because the list is a file and the pins are a projection
// of it. Same preload-scratch-home arrangement and guard as layout.fs.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { APP_HOME } from "./workspaces";
import { CONNECTIONS_PATH, KNOWN_HOSTS_PATH, LOCAL_ID, saveConnections, type Connection } from "./connections";
import { createConnectionManager, type Attached } from "./connectionManager";
import { CONNECTION_METHODS } from "../shared/wire";
import type { RequestHandlers } from "../shared/wire";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

const LAPTOP: Connection = {
  id: "laptop-1",
  name: "Laptop",
  destination: "dan@laptop",
  keyPath: "",
  hostKey: "laptop ssh-ed25519 AAAAC3Nza",
  lastReached: 0,
};

// A fake connection: `vaultState` answers with the id it was attached for, so
// a request proves WHICH server the router reached rather than merely that it
// reached one. `unreachable` is the set of ids that refuse to open.
function fakeAttach(unreachable = new Set<string>()) {
  const log: string[] = [];
  const open = new Set<string>();
  const attach = async (conn: Connection): Promise<Attached> => {
    log.push(`attach:${conn.id}`);
    if (unreachable.has(conn.id)) throw new Error("host is down");
    open.add(conn.id);
    return {
      requests: {
        vaultState: async () => ({ state: conn.id }),
      } as unknown as RequestHandlers,
      build: `build-${conn.id}`,
      shutdown: () => {
        log.push(`shutdown:${conn.id}`);
        open.delete(conn.id);
      },
    };
  };
  return { attach, log, open };
}

const served = async (m: { requests: RequestHandlers }) => (await m.requests.vaultState({})).state as string;

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
});

describe("boot", () => {
  test("a fresh install serves the local server", async () => {
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    expect(await served(m)).toBe(LOCAL_ID);
    const { active, wanted, error, connections } = await m.requests.connectionList({});
    expect(active).toBe(LOCAL_ID);
    expect(wanted).toBe(LOCAL_ID);
    expect(error).toBe("");
    // The local server is in the list without ever having been stored.
    expect(connections.map((c) => c.id)).toEqual([LOCAL_ID]);
  });

  test("the connection chosen last time is the one served", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    expect(await served(m)).toBe(LAPTOP.id);
  });

  // An app that does not open teaches nothing. One that opens on this machine
  // and says why can be fixed from inside itself.
  test("a connection that will not open falls back to the local server, with the reason", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const m = await createConnectionManager({ attach: fakeAttach(new Set([LAPTOP.id])).attach });
    expect(await served(m)).toBe(LOCAL_ID);
    const status = await m.requests.connectionList({});
    expect(status.active).toBe(LOCAL_ID);
    // What the user asked for is still what they asked for: the indicator has
    // to be able to say "wanted Laptop, on This Mac, because host is down".
    expect(status.wanted).toBe(LAPTOP.id);
    expect(status.error).toContain("host is down");
  });

  test("reaching a connection records when", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const m = await createConnectionManager({ attach: fakeAttach().attach, now: () => 1_700_000_000_000 });
    const list = await m.requests.connectionList({});
    expect(list.connections.find((c) => c.id === LAPTOP.id)!.lastReached).toBe(1_700_000_000_000);
  });

  test("the server's build travels from the handshake", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    expect((await m.requests.connectionList({})).build).toBe(`build-${LOCAL_ID}`);
  });
});

describe("switching", () => {
  test("the router points at the new server, and the old one is shut down", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    expect(await m.requests.connectionSelect({ id: LAPTOP.id })).toEqual({ ok: true, error: "" });
    expect(await served(m)).toBe(LAPTOP.id);
    expect(fake.open.has(LOCAL_ID)).toBe(false);
    // Opened before torn down: the session in front of the user is the last
    // thing given up, never the first.
    expect(fake.log).toEqual([`attach:${LOCAL_ID}`, `attach:${LAPTOP.id}`, `shutdown:${LOCAL_ID}`]);
  });

  // Losing a working session to a typo would be the worse failure by far.
  test("a connection that will not open costs nothing", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const fake = fakeAttach(new Set([LAPTOP.id]));
    const m = await createConnectionManager({ attach: fake.attach });
    const res = await m.requests.connectionSelect({ id: LAPTOP.id });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Laptop");
    expect(res.error).toContain("host is down");
    // Still here, still serving.
    expect(await served(m)).toBe(LOCAL_ID);
    expect(fake.open.has(LOCAL_ID)).toBe(true);
  });

  test("the choice survives the next launch", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const first = await createConnectionManager({ attach: fakeAttach().attach });
    await first.requests.connectionSelect({ id: LAPTOP.id });
    const second = await createConnectionManager({ attach: fakeAttach().attach });
    expect(await served(second)).toBe(LAPTOP.id);
  });

  test("selecting the one already being served is a no-op, not a reconnect", async () => {
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    expect(await m.requests.connectionSelect({ id: LOCAL_ID })).toEqual({ ok: true, error: "" });
    expect(fake.log).toEqual([`attach:${LOCAL_ID}`]);
  });

  test("an id naming nothing is refused without touching the connection", async () => {
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    expect((await m.requests.connectionSelect({ id: "nope" })).ok).toBe(false);
    expect(await served(m)).toBe(LOCAL_ID);
  });
});

describe("adding and removing", () => {
  test("an added connection is listed, stored, and switchable", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    const { id, error } = await m.requests.connectionAdd({
      name: "VPS",
      destination: "ledge@vps",
      keyPath: "",
      hostKey: "vps ssh-ed25519 AAAA",
    });
    expect(error).toBe("");
    expect((await m.requests.connectionList({})).connections.map((c) => c.name)).toEqual(["This Mac", "VPS"]);
    expect(JSON.parse(await readFile(CONNECTIONS_PATH, "utf8")).connections).toHaveLength(1);
    expect((await m.requests.connectionSelect({ id })).ok).toBe(true);
  });

  test("what was pinned is what ssh will check", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    await m.requests.connectionAdd({ name: "VPS", destination: "ledge@vps", keyPath: "", hostKey: "vps ssh-ed25519 AAAA" });
    expect(await readFile(KNOWN_HOSTS_PATH, "utf8")).toBe("vps ssh-ed25519 AAAA\n");
  });

  test("a bad destination is refused with a reason and nothing is stored", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    const res = await m.requests.connectionAdd({ name: "VPS", destination: "-oProxyCommand=x", keyPath: "", hostKey: "" });
    expect(res.id).toBe("");
    expect(res.error).toContain("ssh destination");
    expect((await m.requests.connectionList({})).connections).toHaveLength(1);
  });

  test("only what the user was shown is pinned: no host key means no line", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    await m.requests.connectionAdd({ name: "VPS", destination: "ledge@vps", keyPath: "", hostKey: "" });
    expect(await readFile(KNOWN_HOSTS_PATH, "utf8")).toBe("");
    expect((await m.requests.connectionList({})).connections.find((c) => c.name === "VPS")!.pinned).toBe(false);
  });

  test("removing takes the pin with it", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    expect(await m.requests.connectionRemove({ id: LAPTOP.id })).toEqual({ ok: true, error: "" });
    expect(await readFile(KNOWN_HOSTS_PATH, "utf8")).toBe("");
    expect((await m.requests.connectionList({})).connections.map((c) => c.id)).toEqual([LOCAL_ID]);
  });

  // Both refusals are about leaving the app somewhere it can work from.
  test("the local server cannot be removed", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    const res = await m.requests.connectionRemove({ id: LOCAL_ID });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("cannot be removed");
  });

  test("the connection being served cannot be removed", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    const res = await m.requests.connectionRemove({ id: LAPTOP.id });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Switch somewhere else");
    expect(await served(m)).toBe(LAPTOP.id);
  });
});

// The list in bun/clientSeams.ts is what the SERVER refuses; this is what the
// manager answers. A name in one and not the other is a method refused by
// everybody or served by nobody.
test("the listed connection methods are the ones implemented", async () => {
  const m = await createConnectionManager({ attach: fakeAttach().attach });
  for (const name of CONNECTION_METHODS) expect(typeof m.requests[name]).toBe("function");
  // And they are served by the manager rather than forwarded: the fake server
  // above implements only vaultState, so a forwarded call would throw.
  expect((await m.requests.connectionList({})).active).toBe(LOCAL_ID);
});
