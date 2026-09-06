// The log against a real filesystem: rotation, the size cap, and that a log
// write never throws. Runs against the same scratch app home as
// layout.fs.test.ts, behind the same guard.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { APP_HOME } from "./workspaces";
import { LOG_PATH, MAX_LOG_BYTES, PREV_LOG_PATH, append, rotate, write } from "./log";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

const read = (p: string) => readFile(p, "utf8").catch(() => null);

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
});

describe("the session log", () => {
  test("a written line lands in the log", async () => {
    write("bun", "warn", ["[pty] no native trampolines"]);
    expect(await read(LOG_PATH)).toContain("[bun/warn] [pty] no native trampolines");
  });

  test("appends accumulate rather than replacing", async () => {
    append("first\n");
    append("second\n");
    expect(await read(LOG_PATH)).toBe("first\nsecond\n");
  });

  // startLogging rotates at launch (log.ts), so the log of the session that
  // crashed survives the relaunch. Relaunching is the first thing anyone does
  // after a crash. append rotates as well, at the size cap below.
  test("rotation moves the finished session aside, under a name that says so", async () => {
    append("the session that crashed\n");
    rotate();
    append("the session after it\n");
    expect(await read(PREV_LOG_PATH)).toBe("the session that crashed\n");
    expect(await read(LOG_PATH)).toBe("the session after it\n");
  });

  test("rotating a first launch leaves no empty previous log to mislead anyone", async () => {
    rotate();
    expect(await read(PREV_LOG_PATH)).toBeNull();
  });

  test("only one previous session is kept: the older one is what rotation overwrites", async () => {
    append("oldest\n");
    rotate();
    append("middle\n");
    rotate();
    append("current\n");
    expect(await read(PREV_LOG_PATH)).toBe("middle\n");
    expect(await read(LOG_PATH)).toBe("current\n");
  });

  // The cap keeps the log from filling a disk. Rotating rather than
  // truncating keeps the recent end of the log. A crash shows up at that end.
  test("a runaway log rotates itself and keeps writing", async () => {
    append("x".repeat(MAX_LOG_BYTES + 1));
    append("after the cap\n");
    expect(await read(LOG_PATH)).toBe("after the cap\n");
    expect((await read(PREV_LOG_PATH))?.length).toBeGreaterThan(MAX_LOG_BYTES);
  });

  // write swallows its errors, so a logging call cannot add a failure of its
  // own on top of the bug it was recording. Putting a directory where the log
  // file belongs makes every write to it fail.
  test("a log that cannot be written is swallowed, not thrown", async () => {
    await rm(LOG_PATH, { force: true });
    await mkdir(LOG_PATH, { recursive: true });
    expect(() => write("bun", "error", ["something else went wrong"])).not.toThrow();
  });

  test("the log lives under the app home, so a scratch root isolates it", async () => {
    await writeFile(`${APP_HOME}/marker`, "x");
    expect(LOG_PATH.startsWith(APP_HOME + sep)).toBe(true);
    expect(PREV_LOG_PATH.startsWith(APP_HOME + sep)).toBe(true);
  });
});
