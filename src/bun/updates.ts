// This app's own update: when to ask the update server for a newer build, what
// its answer means, and the verb that installs one (releasing.md §7).
//
// Electrobun's Updater does the fetch, the manifest validation, the download
// and the install. This module decides when to call it and turns its answers
// into the UpdateState the view shows. It imports no Electrobun: bun/index.ts
// passes the Updater's functions in, so updates.test.ts drives a fake one.
import type { UpdateState } from "../shared/rpc-schema";

/** The fields of Electrobun's UpdateInfo this module reads. */
export interface CheckResult {
  version: string;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string;
}

/** The fields of Electrobun's LocalUpdateInfo that decide whether this build
 * can update at all. */
export interface LocalBuild {
  channel: string;
  baseUrl: string;
}

/** How long after a successful check the next one is due. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** How long after a failed check the next one is due. A Mac is often offline
 * at launch, and a day is too long to wait for the next try. */
export const RETRY_EVERY_MS = 60 * 60 * 1000;
/** The wait before the first check, so it does not compete with the first
 * windows' own round trips. */
export const FIRST_CHECK_MS = 10_000;
// Timers do not advance while a Mac sleeps, so a 24-hour timer on a laptop that
// is closed every night would seldom fire. A short timer compared against the
// wall clock (checkDue) runs the check on the first wake after it is due.
export const TICK_MS = 5 * 60 * 1000;

// Electrobun's prefixes for its two failures. Stripped, so the view's sentence
// reads "Could not check for updates: HTTP 500" rather than saying it twice.
const FAILURE_PREFIXES = ["Failed to check for updates: ", "Failed to download update: "];

// --- pure core (unit-tested in updates.test.ts) -------------------------------

function state(phase: UpdateState["phase"], version = "", detail = ""): UpdateState {
  return { phase, version, detail };
}

/** Why this build never updates, or "" when it can. A dev build is refused by
 * Electrobun's own check, which answers "no update" rather than saying so. */
export function offReason(build: LocalBuild | null): string {
  if (!build) return "This build could not read its own version information.";
  if (build.channel === "dev") return "Development builds do not update.";
  if (!build.baseUrl) return "This build has no update address.";
  return "";
}

/** Electrobun's failure text, without the prefix that repeats the verb. */
export function failureDetail(error: string): string {
  const prefix = FAILURE_PREFIXES.find((p) => error.startsWith(p));
  return prefix ? error.slice(prefix.length) : error;
}

/** Whether a failed check means nothing has been published yet. The update
 * server answers 404 for the manifest until the first release exists, and that
 * is an up-to-date app rather than a failure (releasing.md §7). */
export function noRelease(error: string): boolean {
  return /\bHTTP 404$/.test(error);
}

/** The state a finished check leaves, for an app running `running`. */
export function afterCheck(result: CheckResult, running: string): UpdateState {
  if (result.error) {
    return noRelease(result.error) ? state("current", running) : state("failed", "", failureDetail(result.error));
  }
  if (result.updateReady) return state("ready", result.version);
  if (result.updateAvailable) return state("downloading", result.version);
  return state("current", running);
}

/** The state a finished download of `version` leaves. */
export function afterDownload(result: CheckResult, version: string): UpdateState {
  if (result.updateReady) return state("ready", version);
  return state("failed", "", failureDetail(result.error) || "the download did not finish");
}

/** Whether a background check is due at `now`, given the last attempt. */
export function checkDue(now: number, last: { at: number; ok: boolean } | null): boolean {
  if (!last) return true;
  return now - last.at >= (last.ok ? CHECK_EVERY_MS : RETRY_EVERY_MS);
}

// --- the controller -----------------------------------------------------------

export interface UpdateDeps {
  /** The running version, reported as the current one. */
  running: string;
  /** offReason's answer for this build. Non-empty turns every verb into a no-op. */
  off: string;
  /** Updater.checkForUpdate, Updater.downloadUpdate, Updater.updateInfo and
   * Updater.applyUpdate. */
  check(): Promise<CheckResult>;
  download(): Promise<void>;
  info(): CheckResult;
  apply(): Promise<void>;
  /** Called with every new state, which bun/index.ts pushes to each window. */
  changed(next: UpdateState): void;
  now?(): number;
  /** setTimeout and setInterval, unref'd so they never hold the process open.
   * Replaced in tests. */
  timers?: Timers;
}

export interface Timers {
  after(ms: number, run: () => void): () => void;
  every(ms: number, run: () => void): () => void;
}

const REAL_TIMERS: Timers = {
  after: (ms, run) => {
    const t = setTimeout(run, ms);
    t.unref();
    return () => clearTimeout(t);
  },
  every: (ms, run) => {
    const t = setInterval(run, ms);
    t.unref();
    return () => clearInterval(t);
  },
};

export interface Updates {
  state(): UpdateState;
  /** Start a check unless one is running, and answer with the state it leaves
   * right now. The results arrive through `changed`. */
  check(): UpdateState;
  /** Install a ready update. On success the app quits and relaunches. */
  install(): Promise<boolean>;
  /** Resolves when the running check and download are finished. For tests. */
  settled(): Promise<void>;
  /** Schedule the first check and the daily ones. Returns the stop.
   * `automatic` is the client setting updates.automatic: false schedules
   * nothing, and check() still works when the user asks. */
  start(options: { automatic: boolean }): () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUpdates(deps: UpdateDeps): Updates {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? REAL_TIMERS;
  let current = deps.off ? state("off", "", deps.off) : state("idle");
  let busy: Promise<void> | null = null;
  let last: { at: number; ok: boolean } | null = null;

  function set(next: UpdateState): void {
    if (next.phase === current.phase && next.version === current.version && next.detail === current.detail) return;
    current = next;
    deps.changed(next);
  }

  async function run(): Promise<void> {
    set(state("checking"));
    const checked = await deps.check().catch(
      (err: unknown): CheckResult => ({ version: "", updateAvailable: false, updateReady: false, error: messageOf(err) }),
    );
    const next = afterCheck(checked, deps.running);
    last = { at: now(), ok: next.phase !== "failed" };
    set(next);
    if (next.phase !== "downloading") return;

    // Electrobun records its own download failures in updateInfo().error and
    // resolves. A throw is the other route, and its message is kept in case
    // the record has none.
    const thrown = await deps.download().then(
      () => "",
      (err: unknown) => messageOf(err),
    );
    const info = deps.info();
    const done = afterDownload({ ...info, error: info.error || thrown }, next.version);
    if (done.phase === "failed") last = { at: now(), ok: false };
    set(done);
  }

  function check(): UpdateState {
    if (current.phase === "off" || current.phase === "ready") return current;
    if (!busy) {
      busy = run().finally(() => {
        busy = null;
      });
    }
    return current;
  }

  return {
    state: () => current,
    check,
    install: async () => {
      if (current.phase !== "ready") return false;
      try {
        await deps.apply();
      } catch (err) {
        set(state("failed", "", messageOf(err)));
        return false;
      }
      // applyUpdate resolves either way. It records a failure to start the
      // install helper in updateInfo().error. A quit that is already under way
      // leaves the error empty, and the state stays "ready" so the windows
      // show nothing alarming in the moment before they close.
      const error = deps.info().error;
      if (!error) return true;
      set(state("failed", "", failureDetail(error)));
      return false;
    },
    settled: async () => {
      while (busy) await busy;
    },
    start: ({ automatic }) => {
      if (current.phase === "off" || !automatic) return () => {};
      const stopFirst = timers.after(FIRST_CHECK_MS, check);
      const stopTick = timers.every(TICK_MS, () => {
        if (checkDue(now(), last)) check();
      });
      return () => {
        stopFirst();
        stopTick();
      };
    },
  };
}
