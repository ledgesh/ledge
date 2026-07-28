// The log against a real filesystem: rotation, the size cap, and the promise
// that a log write can never be the thing that fails. Same preload-scratch-home
// arrangement and same guard as layout.fs.test.ts.
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

  // The point of the whole design: the session that crashed has to survive the
  // relaunch that follows it, because relaunching is what everyone does first.
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

  // A diagnostic that fills a disk is worse than the bug it was recording.
  // Rotating rather than truncating keeps the recent end, which is the half a
  // crash is in.
  test("a runaway log rotates itself and keeps writing", async () => {
    append("x".repeat(MAX_LOG_BYTES + 1));
    append("after the cap\n");
    expect(await read(LOG_PATH)).toBe("after the cap\n");
    expect((await read(PREV_LOG_PATH))?.length).toBeGreaterThan(MAX_LOG_BYTES);
  });

  // Logging must never be the second failure. A directory sitting where the
  // file belongs is the cheapest way to make every write fail.
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
