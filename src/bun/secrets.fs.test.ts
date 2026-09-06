// The askpass helper as a real file (remote.md §4). ssh executes this path, so
// two properties of the file decide whether password authentication works: the
// executable bit, and whether `/bin/sh` parses the script. secrets.test.ts sees
// only the text, so neither one shows up there.
//
// The keychain half is not here. It is a native seam and belongs to the live
// probe (testing.md §6). A unit suite should not write to the login keychain
// hundreds of times a day.
//
// Same preload-scratch-home arrangement and same guard as clientHome.fs.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { APP_HOME } from "./workspaces";
import { CLIENT_HOME } from "./clientHome";
import { ASKPASS_PATH, askpassScript, ensureAskpass } from "./secrets";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

describe("the askpass helper on disk", () => {
  beforeEach(async () => {
    await rm(APP_HOME, { recursive: true, force: true });
    await mkdir(APP_HOME, { recursive: true });
  });

  test("lands in the client home, with the text secrets.test.ts checks", async () => {
    const path = await ensureAskpass();
    expect(path).toBe(ASKPASS_PATH);
    expect(path.startsWith(CLIENT_HOME + sep)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(askpassScript());
  });

  // A file that is only readable does not run, so ssh has no password to send
  // and the login is refused. The refusal arrives as the server's own
  // permission denied message, which sends the reader to the remote host when
  // the fault is a mode bit on this Mac.
  test("is executable, and by nobody else", async () => {
    await ensureAskpass();
    // 0o700 lets this user alone run it, which matters because the script
    // reads the keychain.
    expect((await stat(ASKPASS_PATH)).mode & 0o777).toBe(0o700);
  });

  // A string comparison cannot tell whether `/bin/sh` parses the script. A
  // quoting mistake produces a script that runs and hands ssh the wrong
  // password rather than one that fails.
  test("parses as a shell script", async () => {
    await ensureAskpass();
    const sh = Bun.spawn(["/bin/sh", "-n", ASKPASS_PATH], { stdout: "ignore", stderr: "pipe" });
    const complaint = await new Response(sh.stderr).text();
    expect(await sh.exited).toBe(0);
    expect(complaint).toBe("");
  });

  // The write is unconditional, so a script from an older version of Ledge is
  // overwritten rather than trusted. That matters after a build changes the
  // keychain service name or the hex decoder the script calls. src/bun/index.ts
  // calls ensureAskpass before each password dial, not at launch.
  test("replaces a script an older version left behind", async () => {
    await mkdir(CLIENT_HOME, { recursive: true });
    await writeFile(ASKPASS_PATH, "#!/bin/sh\necho stale\n", { mode: 0o755 });
    await ensureAskpass();
    expect(await readFile(ASKPASS_PATH, "utf8")).toBe(askpassScript());
    expect((await stat(ASKPASS_PATH)).mode & 0o777).toBe(0o700);
  });

  test("writes it even when the client home does not exist yet", async () => {
    await rm(CLIENT_HOME, { recursive: true, force: true });
    await ensureAskpass();
    expect(await readFile(ASKPASS_PATH, "utf8")).toContain("find-generic-password");
  });

  // ensureAskpass writes through a temp file and a rename, like every other
  // write in the app home, so ssh never executes a half-written script.
  test("leaves no temporary file behind", async () => {
    await ensureAskpass();
    const left = [...new Bun.Glob("askpass.sh.tmp-*").scanSync(CLIENT_HOME)];
    expect(left).toEqual([]);
  });
});
