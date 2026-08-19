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
import { CONNECTIONS_PATH, KNOWN_HOSTS_PATH, LOCAL_ID, PORT_UNSET, saveConnections, type Connection } from "./connections";
import { createConnectionManager, type Attached, type ConnectionManager } from "./connectionManager";
import { createConnectionStore, type Secrets } from "./connectionStore";
import { CONNECTION_METHODS } from "../shared/wire";
import type { RequestHandlers } from "../shared/wire";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

const LAPTOP: Connection = {
  id: "laptop-1",
  name: "Laptop",
  destination: "dev@laptop",
  port: PORT_UNSET,
  keyPath: "",
  auth: "key",
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
      recheck: () => log.push(`recheck:${conn.id}`),
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

  // Where the next launch reads a window's server from is the window list, not
  // this file (remote.md §8a): two windows writing one `selected` key would
  // mean the last one to switch decided where the next launch opened. So a
  // switch REPORTS, and the shell records.
  test("a switch reports the new connection for the window list", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const chosen: string[] = [];
    const m = await createConnectionManager({ attach: fakeAttach().attach, onSelect: (id) => chosen.push(id) });
    await m.requests.connectionSelect({ id: LAPTOP.id });
    await m.requests.connectionSelect({ id: LOCAL_ID });
    expect(chosen).toEqual([LAPTOP.id, LOCAL_ID]);
  });

  // Nothing is reported for a switch that did not happen, or the shell would
  // rewrite the window list on every no-op.
  test("a refused switch reports nothing", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const chosen: string[] = [];
    const m = await createConnectionManager({
      attach: fakeAttach(new Set([LAPTOP.id])).attach,
      onSelect: (id) => chosen.push(id),
    });
    await m.requests.connectionSelect({ id: LAPTOP.id });
    await m.requests.connectionSelect({ id: "nope" });
    await m.requests.connectionSelect({ id: LOCAL_ID });
    expect(chosen).toEqual([]);
  });

  // The other half: a window opens where it is told, which is what the shell
  // reads back out of the window list.
  test("a window opens on the connection it is asked for", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const m = await createConnectionManager({ attach: fakeAttach().attach, want: LAPTOP.id });
    expect(await served(m)).toBe(LAPTOP.id);
    expect(m.active()).toBe(LAPTOP.id);
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

  // The no-op above is right for a connection that is working and wrong for
  // one that is dead, and a transport that gave up stays given up on purpose
  // (shared/transport.ts). Choosing the same server again is the recovery the
  // chrome offers, and it is the only one there is, so it has to attach.
  test("selecting the one being served DOES reconnect once its wire has given up", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    m.lost(LAPTOP.id, "Disconnected: another client connected to this server.");
    expect(await m.requests.connectionSelect({ id: LAPTOP.id })).toEqual({ ok: true, error: "" });
    expect(fake.log).toEqual([`attach:${LAPTOP.id}`, `attach:${LAPTOP.id}`, `shutdown:${LAPTOP.id}`]);
  });

  // The other half of the same record, and it is needed because a wire that gave
  // up no longer stays given up: the ladder ends in a beat that keeps dialling
  // (shared/transport.ts). A recovery that left `lost` standing would make
  // choosing the same connection tear down a session that was working again and
  // rebuild the identical one, which on the view's side is a page reload.
  test("a wire that came back on its own makes selecting it a no-op again", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    m.lost(LAPTOP.id, "Lost the connection: host is down.");
    m.restored(LAPTOP.id);
    expect(await m.requests.connectionSelect({ id: LAPTOP.id })).toEqual({ ok: true, error: "" });
    expect(fake.log).toEqual([`attach:${LAPTOP.id}`]);
  });

  // By id from this side too: a dead connection's late recovery must not clear
  // the reason a DIFFERENT one is being reported.
  test("and a recovery reported by a connection nobody is on clears nothing", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    m.lost(LAPTOP.id, "Lost the connection: host is down.");
    m.restored(LOCAL_ID);
    expect(await m.requests.connectionSelect({ id: LAPTOP.id })).toEqual({ ok: true, error: "" });
    expect(fake.log).toEqual([`attach:${LAPTOP.id}`, `attach:${LAPTOP.id}`, `shutdown:${LAPTOP.id}`]);
  });

  // Not a question for the server — there may be no server to ask — but for
  // this window's own wire, which is holding a beat it can be told to cut short.
  test("reconnecting asks the wire being served, and nothing else", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    expect(await m.requests.connectionReconnect({})).toEqual({ ok: true });
    expect(fake.log).toEqual([`attach:${LAPTOP.id}`, `recheck:${LAPTOP.id}`]);
  });

  // A connection reports its own end, and the one being torn down on the way
  // to another can report it after the switch has already landed. Marking the
  // connection now in front of the user dead would be worse than silence.
  test("a connection that dies after being switched away from marks nothing", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    await m.requests.connectionSelect({ id: LAPTOP.id });
    m.lost(LOCAL_ID, "Lost the connection: host is down.");
    expect(await m.requests.connectionSelect({ id: LAPTOP.id })).toEqual({ ok: true, error: "" });
    expect(fake.log).toEqual([`attach:${LOCAL_ID}`, `attach:${LAPTOP.id}`, `shutdown:${LOCAL_ID}`]);
  });
});

// What the shell puts in the title bar (remote.md §8a). Every window said
// "Ledge" before this, which told a person with three of them open nothing at
// all: the one thing a second window is for is being on a second machine.
describe("naming the window", () => {
  const named = async (deps: Parameters<typeof createConnectionManager>[0]) => {
    const names: string[] = [];
    const m = await createConnectionManager({ ...deps, onName: (name) => names.push(name) });
    return { m, names };
  };

  // Reported before the manager returns, because the shell builds the window
  // after that and a window is titled at birth.
  test("a window is named as it boots", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const { names } = await named({ attach: fakeAttach().attach });
    expect(names).toEqual(["Laptop"]);
  });

  // The title says where the window IS, not where it was asked to go: the
  // indicator is what explains the difference.
  test("a window that fell back is named for the machine it landed on", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const { names } = await named({ attach: fakeAttach(new Set([LAPTOP.id])).attach });
    expect(names).toEqual(["This Mac"]);
  });

  test("switching renames the window", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const { m, names } = await named({ attach: fakeAttach().attach });
    await m.requests.connectionSelect({ id: LAPTOP.id });
    await m.requests.connectionSelect({ id: LOCAL_ID });
    expect(names).toEqual(["This Mac", "Laptop", "This Mac"]);
  });

  test("a switch that did not happen renames nothing", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const { m, names } = await named({ attach: fakeAttach(new Set([LAPTOP.id])).attach });
    await m.requests.connectionSelect({ id: LAPTOP.id });
    await m.requests.connectionSelect({ id: "nope" });
    expect(names).toEqual(["This Mac"]);
  });

  // The one case `onSelect` cannot carry: the window went nowhere, and the
  // string on it is the one that changed.
  test("renaming the connection being served renames the window", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const { m, names } = await named({ attach: fakeAttach().attach });
    await m.requests.connectionUpdate({
      id: LAPTOP.id,
      name: "Studio",
      destination: LAPTOP.destination,
      port: PORT_UNSET,
      keyPath: "",
      auth: "key",
      password: null,
      hostKey: null,
    });
    expect(names).toEqual(["Laptop", "Studio"]);
  });

  // A window on this Mac while another connection is edited keeps its title:
  // the edit is about a machine it is not looking at.
  test("renaming a connection this window is not on renames nothing", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const { m, names } = await named({ attach: fakeAttach().attach });
    await m.requests.connectionUpdate({
      id: LAPTOP.id,
      name: "Studio",
      destination: LAPTOP.destination,
      port: PORT_UNSET,
      keyPath: "",
      auth: "key",
      password: null,
      hostKey: null,
    });
    expect(names).toEqual(["This Mac"]);
  });
});

describe("adding and removing", () => {
  test("an added connection is listed, stored, and switchable", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    const { id, error } = await m.requests.connectionAdd({
      name: "VPS",
      destination: "ledge@vps",
      port: PORT_UNSET,
      keyPath: "",
      auth: "key",
      password: "",
      hostKey: "vps ssh-ed25519 AAAA",
    });
    expect(error).toBe("");
    expect((await m.requests.connectionList({})).connections.map((c) => c.name)).toEqual(["This Mac", "VPS"]);
    expect(JSON.parse(await readFile(CONNECTIONS_PATH, "utf8")).connections).toHaveLength(1);
    expect((await m.requests.connectionSelect({ id })).ok).toBe(true);
  });

  test("what was pinned is what ssh will check", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    await m.requests.connectionAdd({ name: "VPS", destination: "ledge@vps", port: PORT_UNSET, keyPath: "", auth: "key", password: "", hostKey: "vps ssh-ed25519 AAAA" });
    expect(await readFile(KNOWN_HOSTS_PATH, "utf8")).toBe("vps ssh-ed25519 AAAA\n");
  });

  test("a bad destination is refused with a reason and nothing is stored", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    const res = await m.requests.connectionAdd({ name: "VPS", destination: "-oProxyCommand=x", port: PORT_UNSET, keyPath: "", auth: "key", password: "", hostKey: "" });
    expect(res.id).toBe("");
    expect(res.error).toContain("ssh destination");
    expect((await m.requests.connectionList({})).connections).toHaveLength(1);
  });

  test("only what the user was shown is pinned: no host key means no line", async () => {
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    await m.requests.connectionAdd({ name: "VPS", destination: "ledge@vps", port: PORT_UNSET, keyPath: "", auth: "key", password: "", hostKey: "" });
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

describe("editing", () => {
  const edit = {
  id: LAPTOP.id,
  name: LAPTOP.name,
  destination: LAPTOP.destination,
  port: PORT_UNSET,
  keyPath: "",
  auth: "key" as const,
  // Null is the form saying it did not ask for one, which is every case here
  // that is not about the password door.
  password: null,
  hostKey: null,
};

  test("a rename keeps everything else, pin included", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    expect(await m.requests.connectionUpdate({ ...edit, name: "Studio" })).toEqual({ ok: true, error: "" });
    const stored = JSON.parse(await readFile(CONNECTIONS_PATH, "utf8")).connections;
    expect(stored).toEqual([{ ...LAPTOP, name: "Studio" }]);
    expect(await readFile(KNOWN_HOSTS_PATH, "utf8")).toBe(`${LAPTOP.hostKey}\n`);
  });

  // The account is not what a host key belongs to: keyscan asked the HOST, and
  // `dev@laptop` to `ledge@laptop` is the same machine and the same key.
  test("changing only the account keeps the pin", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    expect(await m.requests.connectionUpdate({ ...edit, destination: "ledge@laptop" })).toEqual({ ok: true, error: "" });
    expect((await m.requests.connectionList({})).connections[1]).toMatchObject({
      destination: "ledge@laptop",
      pinned: true,
    });
  });

  // A pin is a claim about one machine. Carried across, it would refuse every
  // later connection with a message about a CHANGED host key — the most
  // alarming possible wording for "you typed a new address".
  test("an address that moved to another host has to be pinned again", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    const refused = await m.requests.connectionUpdate({ ...edit, destination: "dev@studio" });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("another host");
    expect(await readFile(KNOWN_HOSTS_PATH, "utf8")).toBe(`${LAPTOP.hostKey}\n`);

    const pinned = await m.requests.connectionUpdate({
      ...edit,
      destination: "dev@studio",
      hostKey: "studio ssh-ed25519 AAAAnew",
    });
    expect(pinned).toEqual({ ok: true, error: "" });
    expect(await readFile(KNOWN_HOSTS_PATH, "utf8")).toBe("studio ssh-ed25519 AAAAnew\n");
  });

  test("a fresh pin naming a third machine is refused too", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    const res = await m.requests.connectionUpdate({
      ...edit,
      destination: "dev@studio",
      hostKey: "somewhere-else ssh-ed25519 AAAA",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("another host");
  });

  test("the same refusals a new connection gets", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const m = await createConnectionManager({ attach: fakeAttach().attach });
    expect((await m.requests.connectionUpdate({ ...edit, destination: "-oProxyCommand=x" })).error)
      .toContain("ssh destination");
    expect((await m.requests.connectionUpdate({ ...edit, name: "  " })).error).toContain("name");
    expect((await m.requests.connectionUpdate({ ...edit, id: "gone" })).error).toContain("no such connection");
    // The server in this process is not a record, so there is nothing about it
    // to change.
    expect((await m.requests.connectionUpdate({ ...edit, id: LOCAL_ID })).error).toContain("not a connection you can edit");
  });

  // The wire in front of the user was built from the old address, so a row
  // saying one machine over a session talking to another is the lie the
  // indicator exists to prevent.
  test("re-addressing the connection being served re-opens it", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    fake.log.length = 0;
    expect(
      await m.requests.connectionUpdate({ ...edit, destination: "dev@studio", hostKey: "studio ssh-ed25519 AAAAnew" }),
    ).toEqual({ ok: true, error: "" });
    // The new one BEFORE the old one goes, which is the order that makes the
    // refusal below free.
    expect(fake.log).toEqual([`attach:${LAPTOP.id}`, `shutdown:${LAPTOP.id}`]);
  });

  // The same promise switching makes: the session in front of the user survives
  // an address that does not answer, and the reason arrives as a sentence.
  test("an address that will not open costs nothing", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    // By destination rather than by id, because an edit keeps the id: what is
    // unreachable here is the new ADDRESS.
    const log: string[] = [];
    const attach = async (conn: Connection): Promise<Attached> => {
      log.push(`attach:${conn.destination}`);
      if (conn.destination === "dev@studio") throw new Error("host is down");
      return {
        requests: { vaultState: async () => ({ state: conn.destination }) } as unknown as RequestHandlers,
        build: "build",
        recheck: () => {},
        shutdown: () => log.push(`shutdown:${conn.destination}`),
      };
    };
    const m = await createConnectionManager({ attach });
    log.length = 0;

    const res = await m.requests.connectionUpdate({
      ...edit,
      destination: "dev@studio",
      hostKey: "studio ssh-ed25519 AAAAnew",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("host is down");
    expect(log).toEqual(["attach:dev@studio"]);
    // Untouched: still the session the user was in, and the record still says
    // where that session actually is.
    expect(await served(m)).toBe(LAPTOP.destination);
    expect((await m.requests.connectionList({})).connections[1]!.destination).toBe(LAPTOP.destination);
    expect(await readFile(KNOWN_HOSTS_PATH, "utf8")).toBe(`${LAPTOP.hostKey}\n`);
  });

  // A rename of the connection being served changes nothing about how it is
  // made, so tearing the session down for it would cost every open tab for a
  // string.
  test("renaming the connection being served does not re-open it", async () => {
    await saveConnections([LAPTOP], LAPTOP.id);
    const fake = fakeAttach();
    const m = await createConnectionManager({ attach: fake.attach });
    fake.log.length = 0;
    await m.requests.connectionUpdate({ ...edit, name: "Studio" });
    expect(fake.log).toEqual([]);
    expect((await m.requests.connectionList({})).connections[1]!.name).toBe("Studio");
  });
});

// Two windows, one list (remote.md §8a). What each of these proves is that the
// split lands where the design puts it: the records are the app's and the
// pointer is the window's.
describe("two windows over one store", () => {
  // Two managers over one store, each on its own connection.
  async function pair(unreachable = new Set<string>()) {
    const fake = fakeAttach(unreachable);
    const store = await createConnectionStore({ inUse: () => [first, second].map((m) => m?.active() ?? "") });
    let first: ConnectionManager | undefined;
    let second: ConnectionManager | undefined;
    first = await createConnectionManager({ attach: fake.attach, store, want: LOCAL_ID });
    second = await createConnectionManager({ attach: fake.attach, store, want: LAPTOP.id });
    return { first, second, fake, store };
  }

  test("each window points where it was told, at the same time", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const { first, second } = await pair();
    expect(await served(first)).toBe(LOCAL_ID);
    expect(await served(second)).toBe(LAPTOP.id);
  });

  // A machine you have paired with is a fact about this Mac, not about one of
  // its windows.
  test("a connection added in one window is listed in the other", async () => {
    const { first, second } = await pair();
    const { id } = await first.requests.connectionAdd({
      name: "VPS",
      destination: "ledge@vps",
      port: PORT_UNSET,
      keyPath: "",
      auth: "key",
      password: "",
      hostKey: "vps ssh-ed25519 AAAA",
    });
    expect((await second.requests.connectionList({})).connections.map((c) => c.id)).toContain(id);
  });

  // Both refusals are about leaving every window somewhere it can work from.
  test("a connection another window is on cannot be removed", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const { first, second } = await pair();
    const res = await first.requests.connectionRemove({ id: LAPTOP.id });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Switch somewhere else");
    expect(await served(second)).toBe(LAPTOP.id);
  });

  // The window that edits can re-open its own wire; the other window's cannot
  // be re-opened from here, and leaving it on the old machine while the row
  // names the new one is the lie the indicator exists to prevent.
  test("re-addressing a connection another window is on waits for that window", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const { first, second } = await pair();
    const res = await first.requests.connectionUpdate({
      id: LAPTOP.id,
      name: LAPTOP.name,
      destination: "dev@studio",
      port: PORT_UNSET,
      keyPath: "",
      auth: "key",
      password: null,
      hostKey: "studio ssh-ed25519 AAAAnew",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Another window");
    expect((await second.requests.connectionList({})).connections[1]!.destination).toBe(LAPTOP.destination);
  });

  // A rename changes nothing about how a connection is made, so it is never
  // refused — tearing a second window's session down for a string would be the
  // cure being worse.
  test("renaming a connection another window is on is allowed", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const { first, second } = await pair();
    const res = await first.requests.connectionUpdate({
      id: LAPTOP.id,
      name: "Studio",
      destination: LAPTOP.destination,
      port: PORT_UNSET,
      keyPath: "",
      auth: "key",
      password: null,
      hostKey: null,
    });
    expect(res).toEqual({ ok: true, error: "" });
    expect((await second.requests.connectionList({})).connections[1]!.name).toBe("Studio");
  });

  // A server that will not open costs its own window a fallback and costs the
  // others nothing.
  test("a window that cannot reach its server falls back alone", async () => {
    await saveConnections([LAPTOP], LOCAL_ID);
    const { first, second } = await pair(new Set([LAPTOP.id]));
    expect(await served(second)).toBe(LOCAL_ID);
    expect((await second.requests.connectionList({})).wanted).toBe(LAPTOP.id);
    expect(await served(first)).toBe(LOCAL_ID);
    expect((await first.requests.connectionList({})).error).toBe("");
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

// The password door (remote.md §4). What is proved here is the ORDER, which is
// where the interesting failures live: the credential has to be in the keychain
// before the dial, because the dial is what proves it, and a dial that then
// fails has to leave the connection exactly as it was.
//
// The keychain itself is a native seam and belongs to the live probe (testing.md
// §6). This one records instead, so a suite that runs hundreds of times a day
// never writes to the login keychain.
function fakeSecrets(refuse = false) {
  const items = new Map<string, string>();
  const log: string[] = [];
  const secrets: Secrets = {
    store: async (id, password) => {
      log.push(`store ${id}`);
      if (refuse) return { ok: false, error: REFUSED };
      items.set(id, password);
      return { ok: true, error: "" };
    },
    has: async (id) => items.has(id),
    forget: async (id) => {
      log.push(`forget ${id}`);
      items.delete(id);
    },
    swap: async (id, next) => {
      log.push(`swap ${id}`);
      if (refuse) return { error: REFUSED, restore: async () => {} };
      const before = items.get(id) ?? null;
      if (next === null) items.delete(id);
      else items.set(id, next);
      return {
        error: "",
        restore: async () => {
          log.push(`restore ${id}`);
          if (before === null) items.delete(id);
          else items.set(id, before);
        },
      };
    },
  };
  return { items, log, secrets };
}

const REFUSED = "The keychain would not store that password.";
const PASSWORD_ADD = {
  name: "VPS",
  destination: "ledge@vps",
  port: PORT_UNSET,
  keyPath: "",
  auth: "password" as const,
  password: "hunter2",
  hostKey: "vps ssh-ed25519 AAAA",
};

describe("the password door", () => {
  beforeEach(async () => {
    await rm(APP_HOME, { recursive: true, force: true });
    await mkdir(APP_HOME, { recursive: true });
  });

  // The record says which door; the keychain holds the secret. Nothing in
  // connections.json is a credential, which is the claim that makes the file
  // safe to read, back up and hand-edit.
  test("stores the password in the keychain and not in the file", async () => {
    const { items, secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    const { id, error } = await store.add(PASSWORD_ADD);
    expect(error).toBe("");
    expect(items.get(id)).toBe("hunter2");
    const written = await readFile(CONNECTIONS_PATH, "utf8");
    expect(written).not.toContain("hunter2");
    expect(JSON.parse(written).connections[0]).toMatchObject({ auth: "password", keyPath: "" });
  });

  // No key is offered on this door (PubkeyAuthentication=no), so a path left
  // behind in the form is dropped rather than stored as a field with no effect.
  test("drops a key path that came with it", async () => {
    const { secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    const { id } = await store.add({ ...PASSWORD_ADD, keyPath: "/home/dev/.ssh/ledge" });
    expect(store.find(id)!.keyPath).toBe("");
  });

  // A password askpass cannot deliver is refused where the user can see it,
  // rather than stored and turned into a server that refuses to talk to them.
  test("refuses a password ssh could not deliver, and stores nothing", async () => {
    const { items, secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    for (const password of ["", "two\nlines", "with\ttab"]) {
      const res = await store.add({ ...PASSWORD_ADD, password });
      expect(res.id).toBe("");
      expect(res.error).not.toBe("");
    }
    expect(items.size).toBe(0);
    expect(store.all()).toHaveLength(1);
  });

  // A keychain that will not take the password leaves no record behind either:
  // the alternative is a connection naming a door with nothing behind it.
  test("a keychain that refuses costs the whole connection", async () => {
    const { secrets } = fakeSecrets(true);
    const store = await createConnectionStore({ secrets });
    const res = await store.add(PASSWORD_ADD);
    expect(res.id).toBe("");
    expect(res.error).toBe(REFUSED);
    expect(store.all()).toHaveLength(1);
  });

  test("removing the connection forgets its password", async () => {
    const { items, log, secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    const { id } = await store.add(PASSWORD_ADD);
    expect(await store.remove(id)).toEqual({ ok: true, error: "" });
    expect(items.size).toBe(0);
    expect(log).toContain(`forget ${id}`);
  });

  // Every connection that has no password should cost no keychain call at all.
  test("an ordinary connection never touches the keychain", async () => {
    const { log, secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    const { id } = await store.add({ ...PASSWORD_ADD, auth: "key", password: "" });
    await store.reviewUpdate({ ...PASSWORD_ADD, id, auth: "key", password: null, hostKey: null });
    await store.swapPassword(id, "key", null);
    await store.remove(id);
    expect(log).toEqual([]);
  });

  // A rename is not a re-credential. Asking for the password again to change a
  // name would teach the user to type it into dialogs for no reason.
  test("a rename keeps the stored password and asks the keychain nothing", async () => {
    const { items, log, secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    const { id } = await store.add(PASSWORD_ADD);
    log.length = 0;
    const { conn, error } = await store.reviewUpdate({
      ...PASSWORD_ADD,
      id,
      name: "Frankfurt",
      password: null,
      hostKey: null,
    });
    expect(error).toBe("");
    await store.swapPassword(id, "password", null);
    expect(log).toEqual([]);
    expect(items.get(id)).toBe("hunter2");
    expect(conn!.name).toBe("Frankfurt");
  });

  // Null means "keep the stored one", which is only an answer when there is one
  // to keep. A connection moved onto this door with nothing behind it would
  // dial, find no secret, and be refused for a reason that is on this Mac.
  test("moving onto the door with nothing stored is refused", async () => {
    const { secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    const { id } = await store.add({ ...PASSWORD_ADD, auth: "key", password: "" });
    const { conn, error } = await store.reviewUpdate({ ...PASSWORD_ADD, id, password: null, hostKey: null });
    expect(conn).toBeNull();
    expect(error).toContain("no password stored");
  });

  test("moving off the door forgets the password", async () => {
    const { items, secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    const { id } = await store.add(PASSWORD_ADD);
    await store.swapPassword(id, "key", null);
    expect(items.size).toBe(0);
  });

  // The one that decides whether an edit is safe to try. The new password has
  // to be in the keychain for the dial to be a dial of the NEW one, and a dial
  // that fails has to put the old one back: otherwise mistyping a password
  // destroys the working one on the way to reporting the failure.
  test("a new password is in place before the dial, and back out after a failed one", async () => {
    const { items, log, secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    const { id } = await store.add(PASSWORD_ADD);
    // Reachable at boot and not afterwards, which is what an edit that
    // mistypes the password looks like from here: the connection worked, and
    // the dial made with the new credential is the one that fails.
    let refuse = false;
    const attach = async (): Promise<Attached> => {
      if (refuse) throw new Error("host is down");
      return { requests: {} as RequestHandlers, build: "b", recheck: () => {}, shutdown: () => {} };
    };
    const m = await createConnectionManager({ attach, store, want: id });
    refuse = true;
    log.length = 0;

    const res = await m.requests.connectionUpdate({
      id,
      name: "VPS",
      destination: "ledge@vps",
      port: PORT_UNSET,
      keyPath: "",
      auth: "password",
      password: "wrong-one",
      hostKey: null,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Could not reach");
    // Swapped in first, then put back — and in that order, which is the whole
    // claim. The keychain ends where it started.
    expect(log).toEqual([`swap ${id}`, `restore ${id}`]);
    expect(items.get(id)).toBe("hunter2");
  });

  // And the same edit against a machine that answers keeps the new one.
  test("a new password that dials survives", async () => {
    const { items, secrets } = fakeSecrets();
    const store = await createConnectionStore({ secrets });
    const { id } = await store.add(PASSWORD_ADD);
    const m = await createConnectionManager({ attach: fakeAttach().attach, store, want: id });
    const res = await m.requests.connectionUpdate({
      id,
      name: "VPS",
      destination: "ledge@vps",
      port: PORT_UNSET,
      keyPath: "",
      auth: "password",
      password: "the-new-one",
      hostKey: null,
    });
    expect(res).toEqual({ ok: true, error: "" });
    expect(items.get(id)).toBe("the-new-one");
  });
});
