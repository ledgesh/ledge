// The askpass helper as a real file (remote.md §4).
//
// ssh executes this path, so the two things that decide whether the password
// door works at all are properties of the file rather than of the string:
// whether it is executable, and whether `/bin/sh` will parse it. Both are
// invisible to secrets.test.ts, which only ever sees the text.
//
// The keychain half is not here. It is a native seam and belongs to the live
// probe (testing.md §6), and a unit suite should not be writing to the login
// keychain hundreds of times a day.
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

  // ssh spawns it. A file that is merely readable is an authentication that
  // fails with "permission denied" from the wrong side of the connection.
  test("is executable, and by nobody else", async () => {
    await ensureAskpass();
    // 0o700: nobody but this user has any business running it, and it is a
    // program that reads the keychain.
    expect((await stat(ASKPASS_PATH)).mode & 0o777).toBe(0o700);
  });

  // The one property a string comparison cannot check. A quoting mistake here
  // is a script that runs and answers WRONGLY rather than one that fails.
  test("parses as a shell script", async () => {
    await ensureAskpass();
    const sh = Bun.spawn(["/bin/sh", "-n", ASKPASS_PATH], { stdout: "ignore", stderr: "pipe" });
    const complaint = await new Response(sh.stderr).text();
    expect(await sh.exited).toBe(0);
    expect(complaint).toBe("");
  });

  // Rewritten every launch rather than written once, so a script from an older
  // version is replaced rather than trusted. The case that matters is a build
  // that changed the service name or the decoder.
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

  // Via a temp file and a rename, like every other write in the app home, so
  // ssh never executes a script that is halfway written.
  test("leaves no temporary file behind", async () => {
    await ensureAskpass();
    const left = [...new Bun.Glob("askpass.sh.tmp-*").scanSync(CLIENT_HOME)];
    expect(left).toEqual([]);
  });
});
