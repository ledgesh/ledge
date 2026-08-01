// The dedupe window (remote.md §7). Pure and clock-injected, so "two minutes
// later" costs nothing and the eviction rules are actually asserted rather
// than assumed.
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

  // The window is per client AND per op (the server keys it with both), so two
  // clients counting from 1 do not answer each other's calls.
  test("a different key is a different op", async () => {
    const log = createOpLog();
    const c = counter();
    await log.run("mac:1", c.exec);
    await log.run("phone:1", c.exec);
    expect(c.runs()).toBe(2);
  });

  // The case a fast reconnect actually produces: the replay lands while the
  // original is still writing the file. Two writes racing each other is the
  // failure this whole mechanism exists to prevent, so it must not start a
  // second one — it has to wait on the first.
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

  // A refusal is an answer. Replaying a write the vault refused must be
  // refused again rather than retried into a vault that has since been
  // unlocked, which would apply what the user was told did not happen.
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
    // "a" was evicted, so its replay runs again. That is the honest failure
    // mode of a bounded window, and the bound is what keeps a recorded
    // scrollback replay from being held forever.
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
    // The eviction sweep runs on the next write, so it takes another op to
    // clear the stale one — then the replay is a fresh run.
    await log.run("b", c.exec);
    await log.run("a", c.exec);
    expect(c.runs()).toBe(3);
  });
});
