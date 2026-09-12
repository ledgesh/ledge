import { describe, expect, test } from "bun:test";
import type { UpdateState } from "../shared/rpc-schema";
import {
  afterCheck,
  afterDownload,
  CHECK_EVERY_MS,
  checkDue,
  createUpdates,
  failureDetail,
  FIRST_CHECK_MS,
  noRelease,
  offReason,
  RETRY_EVERY_MS,
  TICK_MS,
  type CheckResult,
  type Timers,
  type UpdateDeps,
} from "./updates";

const NOTHING: CheckResult = { version: "", updateAvailable: false, updateReady: false, error: "" };

// Electrobun's own wording (Updater.ts checkForUpdateOperation), which the
// 404 rule reads. If Electrobun rewords it, this test is where that shows up.
const NOT_PUBLISHED = "Failed to check for updates: HTTP 404";

describe("offReason", () => {
  test("a stable build with an update address updates", () => {
    expect(offReason({ channel: "stable", baseUrl: "https://ledge.sh/updates" })).toBe("");
  });

  // Electrobun's check answers a dev build with "no update", which would read
  // as "Ledge is up to date" on a build that never looks.
  test("a dev build does not", () => {
    expect(offReason({ channel: "dev", baseUrl: "https://ledge.sh/updates" })).not.toBe("");
  });

  test("a build with no update address does not", () => {
    expect(offReason({ channel: "stable", baseUrl: "" })).not.toBe("");
  });

  test("a build that could not read its own information does not", () => {
    expect(offReason(null)).not.toBe("");
  });
});

describe("afterCheck", () => {
  // The update server answers 404 until the first release is published. Every
  // install before then must read that as up to date, not as a failure.
  test("a manifest that is not published yet means up to date", () => {
    expect(noRelease(NOT_PUBLISHED)).toBe(true);
    expect(afterCheck({ ...NOTHING, error: NOT_PUBLISHED }, "0.1.0")).toEqual({ phase: "current", version: "0.1.0", detail: "" });
  });

  test("any other failure is a failure, without Electrobun's prefix", () => {
    const next = afterCheck({ ...NOTHING, error: "Failed to check for updates: HTTP 500" }, "0.1.0");
    expect(next).toEqual({ phase: "failed", version: "", detail: "HTTP 500" });
  });

  // A 404 inside some other sentence is not the manifest's own status.
  test("only a trailing HTTP 404 counts as unpublished", () => {
    expect(noRelease("Failed to check for updates: HTTP 404 from a proxy, retrying")).toBe(false);
  });

  test("no newer build means current, named by the running version", () => {
    expect(afterCheck(NOTHING, "0.1.0")).toEqual({ phase: "current", version: "0.1.0", detail: "" });
  });

  test("a newer build is downloading, named by its own version", () => {
    expect(afterCheck({ ...NOTHING, version: "0.1.1", updateAvailable: true }, "0.1.0").phase).toBe("downloading");
  });

  // An update downloaded in an earlier session is already prepared, and the
  // check says so. It goes straight to ready without a second download.
  test("a newer build that is already downloaded is ready", () => {
    const next = afterCheck({ version: "0.1.1", updateAvailable: true, updateReady: true, error: "" }, "0.1.0");
    expect(next).toEqual({ phase: "ready", version: "0.1.1", detail: "" });
  });
});

describe("afterDownload", () => {
  test("a prepared update is ready", () => {
    expect(afterDownload({ ...NOTHING, updateReady: true }, "0.1.1")).toEqual({ phase: "ready", version: "0.1.1", detail: "" });
  });

  test("a failed download says why", () => {
    const next = afterDownload({ ...NOTHING, error: "Failed to download update: disk full" }, "0.1.1");
    expect(next).toEqual({ phase: "failed", version: "", detail: "disk full" });
  });

  test("a download that is not ready and gave no reason still fails", () => {
    expect(afterDownload(NOTHING, "0.1.1").detail).not.toBe("");
  });
});

describe("failureDetail", () => {
  test("leaves text without a known prefix alone", () => {
    expect(failureDetail("fetch failed")).toBe("fetch failed");
  });
});

describe("checkDue", () => {
  test("is due before anything has been tried", () => {
    expect(checkDue(0, null)).toBe(true);
  });

  test("a successful check is not repeated for a day", () => {
    expect(checkDue(CHECK_EVERY_MS - 1, { at: 0, ok: true })).toBe(false);
    expect(checkDue(CHECK_EVERY_MS, { at: 0, ok: true })).toBe(true);
  });

  test("a failed check is retried after an hour", () => {
    expect(checkDue(RETRY_EVERY_MS - 1, { at: 0, ok: false })).toBe(false);
    expect(checkDue(RETRY_EVERY_MS, { at: 0, ok: false })).toBe(true);
  });
});

describe("createUpdates", () => {
  function harness(over: Partial<UpdateDeps> = {}) {
    const pushed: UpdateState[] = [];
    const calls: string[] = [];
    let info: CheckResult = NOTHING;
    const deps: UpdateDeps = {
      running: "0.1.0",
      off: "",
      check: async () => {
        calls.push("check");
        return { ...NOTHING, version: "0.1.1", updateAvailable: true };
      },
      download: async () => {
        calls.push("download");
        info = { version: "0.1.1", updateAvailable: true, updateReady: true, error: "" };
      },
      info: () => info,
      apply: async () => {
        calls.push("apply");
      },
      changed: (next) => pushed.push(next),
      ...over,
    };
    return { updates: createUpdates(deps), pushed, calls, setInfo: (next: CheckResult) => (info = next) };
  }

  test("a build that does not update answers off and asks nobody", async () => {
    const { updates, calls } = harness({ off: "Development builds do not update." });
    expect(updates.check().phase).toBe("off");
    await updates.settled();
    expect(calls).toEqual([]);
    expect(await updates.install()).toBe(false);
  });

  // The RPC answers with this state straight away. The check itself can take
  // longer than the request timeout, so its result has to be a push.
  test("check answers at once with checking, and pushes the rest", async () => {
    const { updates, pushed } = harness();
    expect(updates.check().phase).toBe("checking");
    await updates.settled();
    expect(pushed.map((s) => s.phase)).toEqual(["checking", "downloading", "ready"]);
    expect(updates.state()).toEqual({ phase: "ready", version: "0.1.1", detail: "" });
  });

  test("a check while one is running starts nothing new", async () => {
    const { updates, calls } = harness();
    updates.check();
    updates.check();
    await updates.settled();
    expect(calls).toEqual(["check", "download"]);
  });

  test("a ready update is not checked for again", async () => {
    const { updates, calls } = harness();
    updates.check();
    await updates.settled();
    expect(updates.check().phase).toBe("ready");
    await updates.settled();
    expect(calls).toEqual(["check", "download"]);
  });

  test("nothing published yet pushes current, with no download", async () => {
    const { updates, pushed, calls } = harness({
      check: async () => ({ ...NOTHING, error: NOT_PUBLISHED }),
    });
    updates.check();
    await updates.settled();
    expect(pushed.map((s) => s.phase)).toEqual(["checking", "current"]);
    expect(calls).toEqual([]);
  });

  test("a check that throws is a failure with its message", async () => {
    const { updates } = harness({
      check: async () => {
        throw new Error("offline");
      },
    });
    updates.check();
    await updates.settled();
    expect(updates.state()).toEqual({ phase: "failed", version: "", detail: "offline" });
  });

  test("a download that throws is a failure with its message", async () => {
    const { updates } = harness({
      download: async () => {
        throw new Error("connection reset");
      },
    });
    updates.check();
    await updates.settled();
    expect(updates.state()).toEqual({ phase: "failed", version: "", detail: "connection reset" });
  });

  test("install does nothing until an update is ready", async () => {
    const { updates, calls } = harness();
    expect(await updates.install()).toBe(false);
    expect(calls).toEqual([]);
  });

  test("install hands a ready update to the updater", async () => {
    const { updates, calls } = harness();
    updates.check();
    await updates.settled();
    expect(await updates.install()).toBe(true);
    expect(calls).toEqual(["check", "download", "apply"]);
  });

  test("an install that could not start says why and reports false", async () => {
    const h = harness();
    h.updates.check();
    await h.updates.settled();
    h.setInfo({ version: "0.1.1", updateAvailable: true, updateReady: true, error: "Failed to start update helper: EACCES" });
    expect(await h.updates.install()).toBe(false);
    expect(h.updates.state().phase).toBe("failed");
  });

  test("an unchanged state is not pushed twice", async () => {
    const { updates, pushed } = harness({ check: async () => NOTHING });
    updates.check();
    await updates.settled();
    const count = pushed.length;
    // A second check pushes checking, then current again: two changes, never
    // a repeat of the state already showing.
    updates.check();
    await updates.settled();
    expect(pushed.slice(count).map((s) => s.phase)).toEqual(["checking", "current"]);
    for (let i = 1; i < pushed.length; i++) expect(pushed[i]).not.toEqual(pushed[i - 1]!);
  });

  describe("start", () => {
    // Timers that only record what was scheduled, so a test fires them by hand.
    function fakeTimers() {
      const pending: Array<{ kind: "after" | "every"; ms: number; run: () => void; stopped: boolean }> = [];
      const add = (kind: "after" | "every") => (ms: number, run: () => void) => {
        const entry = { kind, ms, run, stopped: false };
        pending.push(entry);
        return () => {
          entry.stopped = true;
        };
      };
      const timers: Timers = { after: add("after"), every: add("every") };
      return { timers, pending };
    }

    test("schedules the first check and the tick", () => {
      const { timers, pending } = fakeTimers();
      const { updates } = harness({ timers });
      const stop = updates.start({ automatic: true });
      expect(pending.map(({ kind, ms }) => ({ kind, ms }))).toEqual([
        { kind: "after", ms: FIRST_CHECK_MS },
        { kind: "every", ms: TICK_MS },
      ]);
      stop();
      expect(pending.every((t) => t.stopped)).toBe(true);
    });

    test("the tick checks only when a check is due", async () => {
      const { timers, pending } = fakeTimers();
      let clock = 0;
      let checks = 0;
      const { updates } = harness({
        timers,
        now: () => clock,
        check: async () => {
          checks++;
          return NOTHING;
        },
      });
      updates.start({ automatic: true });
      const [first, tick] = pending;
      first!.run();
      await updates.settled();
      clock = CHECK_EVERY_MS - 1;
      tick!.run();
      await updates.settled();
      expect(checks).toBe(1);
      clock = CHECK_EVERY_MS;
      tick!.run();
      await updates.settled();
      expect(checks).toBe(2);
    });

    // updates.automatic set to false. The menu's Check for Updates… is the
    // only way a check happens, and it still downloads what it finds.
    test("automatic off schedules nothing, and a check still runs", async () => {
      const { timers, pending } = fakeTimers();
      const { updates, calls } = harness({ timers });
      updates.start({ automatic: false });
      expect(pending).toEqual([]);
      updates.check();
      await updates.settled();
      expect(calls).toEqual(["check", "download"]);
      expect(updates.state().phase).toBe("ready");
    });

    test("a build that does not update schedules nothing either way", () => {
      const { timers, pending } = fakeTimers();
      const { updates } = harness({ timers, off: "Development builds do not update." });
      updates.start({ automatic: true });
      expect(pending).toEqual([]);
    });
  });
});
