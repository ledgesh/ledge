// The client id against a real filesystem. It is the key the server files this
// client's layout under (remote.md §5), so the properties that matter are that
// it survives a relaunch and that nothing on the read path can turn it into a
// different id — a re-mint would silently orphan a saved arrangement rather
// than fail.
//
// Same preload-scratch-home arrangement and same guard as layout.fs.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { APP_HOME } from "./workspaces";
import { CLIENT_HOME, CLIENT_ID_PATH, clientId, ensureClientHome, isClientId } from "./clientHome";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

// clientId caches for the life of the process, which is exactly what a client
// wants and exactly what a test suite cannot have: every case here reaches
// past the cache by reading and writing the file itself, and calls clientId()
// at most once per process. That one call is the first test below.
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

  // The one property the server's layout map depends on: the id a launch
  // reports is the id the launch before it did. In-process the answer is
  // cached, so this asks two real processes.
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

  // Not a hypothetical: the file is one line of text in a folder people back up
  // and sync. What matters is not just that garbage is rejected but that it is
  // REPLACED — leaving it in place would mint a fresh id at every launch and
  // orphan the saved layout every time. Through a fresh process because the
  // read happens once per process and is cached after.
  test("a garbage id file is replaced with a real one, once", async () => {
    await ensureClientHome();
    await writeFile(CLIENT_ID_PATH, "half a wri", "utf8");
    const first = await mintInFreshProcess();
    expect(isClientId(first)).toBe(true);
    expect((await readFile(CLIENT_ID_PATH, "utf8")).trim()).toBe(first);
    // The launch after that reads the file rather than minting again, which is
    // the whole point of writing it.
    expect(await mintInFreshProcess()).toBe(first);
  });
});

// A whole `bun -e` per call, because "what does a launch see?" is the question
// and a launch is a process. LEDGE_NOTES_ROOT is inherited from the preload's
// scratch home, so this reads and writes the same files the test does.
async function mintInFreshProcess(): Promise<string> {
  const p = Bun.spawn(
    [process.execPath, "-e", `import { clientId } from "${resolve(import.meta.dir, "clientHome.ts")}"; console.log(await clientId())`],
    { env: { ...process.env, LEDGE_NOTES_ROOT: APP_HOME }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return out.trim();
}
