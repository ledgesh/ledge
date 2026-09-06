// Tests for the dedupe window (opLog.ts, remote.md §7). The module does no
// I/O, so a test builds a log and calls it directly. createOpLog takes its
// limit, ttl and clock as options. The tests below run with a limit of 3 and
// a ttl of 100ms, stepping an injected clock past it, so eviction is asserted
// rather than assumed.
import { describe, expect, test } from "bun:test";
import { createOpLog } from "./opLog";

function counter() {
  let runs = 0;
  return { runs: () => runs, exec: async () => ({ ran: ++runs }) };
}

describe("an op that arrives twice", () => {
  test("runs once and answers both times with the same result", async () => {
    const log = createOpLog();
    const c = counter();
    expect(await log.run("a", c.exec)).toEqual({ ran: 1 });
    expect(await log.run("a", c.exec)).toEqual({ ran: 1 });
    expect(c.runs()).toBe(1);
  });

  // The server keys the window by client as well as by op: bun/transport.ts
  // joins the peer's client id and the request's op id. Two clients counting
  // from 1 do not answer each other's calls.
  test("a different key is a different op", async () => {
    const log = createOpLog();
    const c = counter();
    await log.run("mac:1", c.exec);
    await log.run("phone:1", c.exec);
    expect(c.runs()).toBe(2);
  });

  // The case a fast reconnect produces: the replay arrives while the original
  // is still writing the file. Two writes racing each other is the failure the
  // op log prevents, so the replay must not start a second run. It gets the
  // first call's promise and waits on it.
  test("a replay that arrives mid-flight waits for the original", async () => {
    const log = createOpLog();
    let release!: (v: { ran: number }) => void;
    let runs = 0;
    const exec = () => {
      runs += 1;
      return new Promise<{ ran: number }>((resolve) => (release = resolve));
    };
    const first = log.run("a", exec);
    const second = log.run("a", exec);
    expect(runs).toBe(1);
    release({ ran: 1 });
    expect(await first).toEqual({ ran: 1 });
    expect(await second).toEqual({ ran: 1 });
  });

  // A failure is recorded the same way a result is. A write the vault refused
  // is refused again on replay, not retried into a vault that has since been
  // unlocked. Retrying would apply a change the user was told did not happen.
  test("a failure is recorded too, and replayed as the same failure", async () => {
    const log = createOpLog();
    let runs = 0;
    const exec = async () => {
      runs += 1;
      throw new Error("this note is locked");
    };
    await expect(log.run("a", exec)).rejects.toThrow("this note is locked");
    await expect(log.run("a", exec)).rejects.toThrow("this note is locked");
    expect(runs).toBe(1);
  });
});

describe("the window is bounded", () => {
  test("the oldest entries go when it is full", async () => {
    const log = createOpLog({ limit: 3 });
    const c = counter();
    for (const key of ["a", "b", "c", "d"]) await log.run(key, c.exec);
    expect(log.size()).toBe(3);
    // "a" was evicted, so its replay runs again. The limit is what keeps the
    // log small: one recorded result, terminalAttach's scrollback replay, is a
    // quarter megabyte (opLog.ts).
    await log.run("a", c.exec);
    expect(c.runs()).toBe(5);
    // "d" is still remembered.
    await log.run("d", c.exec);
    expect(c.runs()).toBe(5);
  });

  test("entries older than the ttl are forgotten", async () => {
    let clock = 1_000;
    const log = createOpLog({ ttlMs: 100, now: () => clock });
    const c = counter();
    await log.run("a", c.exec);
    clock += 50;
    await log.run("a", c.exec);
    expect(c.runs()).toBe(1);
    clock += 500;
    // The sweep runs only after a miss records its entry, so it takes another
    // op to clear the stale one. The replay after that is a fresh run.
    await log.run("b", c.exec);
    await log.run("a", c.exec);
    expect(c.runs()).toBe(3);
  });
});
