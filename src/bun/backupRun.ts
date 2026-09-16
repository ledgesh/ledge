// The backup as it runs on a machine: the restic binary (found on the PATH or
// fetched and verified), one run under a lock, the state file it leaves, and
// the schedule the daemon keeps. The rules are backup.ts's; this file is the
// I/O around them (remote.md §11).
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKUP_EVERY_MS,
  BACKUP_PROFILE,
  backupArgs,
  backupSet,
  type BackupConfig,
  type BackupState,
  diffArgs,
  forgetArgs,
  forgetDue,
  forgetOneArgs,
  idleExitWorthIt,
  isOverdue,
  nextDue,
  parseBackupConfig,
  parseBackupOutput,
  parseDiffChanges,
  parseSnapshots,
  parseState,
  pruneDue,
  recordRun,
  RESTIC_MIN_VERSION,
  RESTIC_RELEASES,
  RESTIC_VERSION,
  resticAsset,
  resticVersionOf,
  type SnapshotInfo,
  versionAtLeast,
} from "./backup";
import { PROFILES_DIR } from "./spawnParams";
import { APP_HOME, roots } from "./workspaces";

/** Everything the backup keeps for itself, inside the excluded `.server`. */
export const BACKUP_DIR = join(APP_HOME, ".server", "backup");
export const STATE_PATH = join(BACKUP_DIR, "state.json");
export const LOCK_PATH = join(BACKUP_DIR, "lock");
/** restic's cache, here rather than ~/.cache so the backup never carries it. */
export const RESTIC_CACHE_DIR = join(BACKUP_DIR, "cache");
export const PROFILE_PATH = join(PROFILES_DIR, `${BACKUP_PROFILE}.env`);

export type Log = (line: string) => void;

// --- the profile -------------------------------------------------------------

export function readConfig(): ReturnType<typeof parseBackupConfig> {
  let text: string | null = null;
  try {
    text = readFileSync(PROFILE_PATH, "utf8");
  } catch {
    // No profile: not set up.
  }
  return parseBackupConfig(text);
}

export function configured(): BackupConfig | null {
  const read = readConfig();
  return "config" in read ? read.config : null;
}

/** restic's environment: the machine's, the profile's on top, and the cache pinned. */
export function resticEnv(config: BackupConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, config.env);
  env["RESTIC_CACHE_DIR"] = RESTIC_CACHE_DIR;
  return env;
}

// --- the binary --------------------------------------------------------------

export type ResticFound = { path: string; version: string } | { missing: string };

/** Where a fetched restic lives. The version is in the name so a bump fetches beside the old one. */
export function fetchedResticPath(version = RESTIC_VERSION): string {
  return join(BACKUP_DIR, `restic-${version}`);
}

/**
 * The restic to run: one on the PATH that is new enough, else the one Ledge
 * fetched, else (with `fetch`) a fresh download. A PATH restic that is too
 * old is passed over rather than refused, since the fetched one serves.
 */
export async function findRestic(opts: { fetch?: boolean; log?: Log } = {}): Promise<ResticFound> {
  const onPath = Bun.which("restic", { PATH: process.env["PATH"] ?? "" });
  if (onPath) {
    const version = await versionOf(onPath);
    if (version && versionAtLeast(version, RESTIC_MIN_VERSION)) return { path: onPath, version };
    opts.log?.(`[backup] ${onPath} is restic ${version ?? "of an unknown version"}; ${RESTIC_MIN_VERSION} or newer is needed`);
  }
  const fetched = fetchedResticPath();
  if (existsSync(fetched)) {
    const version = await versionOf(fetched);
    if (version) return { path: fetched, version };
  }
  if (!opts.fetch) {
    return { missing: onPath ? `restic on the PATH is too old and none has been fetched: run \`ledge backup setup\`` : "restic is not installed: run `ledge backup setup`" };
  }
  try {
    await fetchRestic({ dest: fetched, log: opts.log });
  } catch (err) {
    return { missing: err instanceof Error ? err.message : String(err) };
  }
  const version = await versionOf(fetched);
  return version ? { path: fetched, version } : { missing: `${fetched} does not run here` };
}

async function versionOf(path: string): Promise<string | null> {
  try {
    const p = Bun.spawn([path, "version"], { env: process.env, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    return resticVersionOf(text);
  } catch {
    return null;
  }
}

/**
 * Download the pinned release for this machine, check its SHA-256 against the
 * table in backup.ts, unpack it with the system's bzip2, and rename it into
 * place. Nothing lands at `dest` until every step has passed.
 */
export async function fetchRestic(o: {
  dest: string;
  platform?: string;
  arch?: string;
  releases?: string;
  sha256?: string;
  log?: Log;
}): Promise<void> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const asset = resticAsset(platform, arch, o.releases ?? process.env["LEDGE_RESTIC_RELEASES"] ?? RESTIC_RELEASES);
  if (!asset) throw new Error(`no restic release is pinned for ${platform}-${arch}; install restic yourself and put it on the PATH`);
  const sha256 = o.sha256 ?? asset.sha256;
  const bzip2 = Bun.which("bzip2", { PATH: process.env["PATH"] ?? "" });
  if (!bzip2) throw new Error("bzip2 is needed to unpack restic and is not installed (apt-get install bzip2), or install restic yourself");

  o.log?.(`[backup] downloading restic ${RESTIC_VERSION} from ${asset.url}`);
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`${asset.url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (got !== sha256) throw new Error(`${asset.file}: SHA-256 ${got} is not the pinned ${sha256}; not installing it`);

  mkdirSync(BACKUP_DIR, { recursive: true });
  const packed = `${o.dest}.bz2.tmp-${process.pid}`;
  const unpacked = `${o.dest}.tmp-${process.pid}`;
  try {
    writeFileSync(packed, bytes);
    const out = openSync(unpacked, "w", 0o755);
    const p = Bun.spawn([bzip2, "-dc", packed], { env: process.env, stdout: out, stderr: "pipe", stdin: "ignore" });
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    closeSync(out);
    if (code !== 0) throw new Error(`bzip2 could not unpack ${asset.file}: ${err.trim()}`);
    chmodSync(unpacked, 0o755);
    renameSync(unpacked, o.dest);
  } finally {
    for (const f of [packed, unpacked]) {
      try {
        unlinkSync(f);
      } catch {
        // Renamed away or never written.
      }
    }
  }
  o.log?.(`[backup] restic ${RESTIC_VERSION} installed at ${o.dest}`);
}

// --- running restic ----------------------------------------------------------

export interface ResticResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run restic with the profile's environment, capturing both streams. */
export async function runRestic(restic: string, args: readonly string[], env: Record<string, string>): Promise<ResticResult> {
  const p = Bun.spawn([restic, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, stdout, stderr };
}

/** restic's own words for a failure: the last lines of stderr, one line. */
export function resticSaid(r: ResticResult): string {
  const lines = r.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("unable to open cache"));
  return (lines.slice(-3).join(" ") || `exited ${r.code}`).slice(0, 400);
}

// --- state and lock ----------------------------------------------------------

export function readState(): BackupState {
  try {
    return parseState(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return parseState(null);
  }
}

export function writeState(state: BackupState): void {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, STATE_PATH);
}

/**
 * Hold the backup lock for `fn`, or report who has it. The lock is a file
 * holding a pid: the daemon's hourly run, its idle-exit run and a `now` typed
 * by hand must not overlap. A lock whose pid is gone is a crash's, and is taken.
 */
export async function withBackupLock<T>(fn: () => Promise<T>): Promise<{ result: T } | { busy: number }> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number(readFileSync(LOCK_PATH, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return { busy: holder };
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        // Whoever else saw it stale got there first; the retry finds out.
      }
      if (attempt === 1) return { busy: holder };
    }
  }
  try {
    return { result: await fn() };
  } finally {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      // Already gone.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The registered roots split by whether they are on disk right now. Asked
 * of the disk rather than `availableRoots()`, which is a load-time snapshot
 * (workspaces.ts): a volume unmounted since the daemon started must be
 * skipped, not named to restic, which fails the whole run over it.
 */
export function rootsOnDisk(): { present: string[]; skipped: string[] } {
  const present: string[] = [];
  const skipped: string[] = [];
  for (const r of roots()) (existsSync(r) ? present : skipped).push(r);
  return { present, skipped };
}

// --- one run -----------------------------------------------------------------

export type RunResult =
  | { ok: true; snapshot: string | null; changed: boolean; pruned: boolean; skipped: string[]; errors: string[] }
  | { ok: false; error: string; skipped: string[] }
  | { ok: false; error: string; busy: number }
  | { ok: false; error: string; unconfigured: true };

/**
 * One backup: the paths as of now (the caller has loaded the registry), a
 * restic `backup` with them, then `forget` with the retention policy, pruning
 * once a day. The outcome is written to the state file whatever it was.
 * `secrets: false` leaves the profiles out (`--no-secrets`).
 */
export async function runBackup(o: { log?: Log; reason: string; secrets?: boolean } = { reason: "now" }): Promise<RunResult> {
  const log = o.log ?? (() => {});
  const config = configured();
  if (!config) return { ok: false, error: "backups are not set up on this machine: run `ledge backup setup`", unconfigured: true };
  const restic = await findRestic({ log });
  if ("missing" in restic) return { ok: false, error: restic.missing, skipped: [] };

  const locked = await withBackupLock(async () => {
    const at = new Date();
    const env = resticEnv(config);
    const { present, skipped } = rootsOnDisk();
    for (const r of skipped) log(`[backup] skipping ${r}: not on disk (unmounted volume?)`);
    const set = backupSet({ appHome: APP_HOME, profilesDir: PROFILES_DIR, roots: present, secrets: o.secrets ?? true });

    // Under BACKUP_DIR, which the backup excludes, and never under the system
    // temp dir: restic records the metadata of every ancestor of a target, so
    // a scratch file in an ancestor makes an unchanged tree look changed.
    const dir = await mkdtemp(join(BACKUP_DIR, "run-"));
    const filesFrom = join(dir, "include");
    const excludeFile = join(dir, "exclude");
    try {
      writeFileSync(filesFrom, `${set.include.join("\n")}\n`);
      writeFileSync(excludeFile, `${set.exclude.join("\n")}\n`);
      log(`[backup] ${o.reason}: backing up ${set.include.length} path${set.include.length === 1 ? "" : "s"} to ${config.repository}`);
      const backed = await runRestic(restic.path, backupArgs({ filesFrom, excludeFile }), env);
      if (backed.code !== 0) {
        const error = `restic backup failed: ${resticSaid(backed)}`;
        log(`[backup] ${error}`);
        writeState(recordRun(readState(), { at, ok: false, error, skipped }));
        return { ok: false as const, error, skipped };
      }
      const out = parseBackupOutput(backed.stdout);
      for (const e of out.errors) log(`[backup] restic: ${e}`);
      // restic's own unchanged check is fooled by a busy parent folder
      // (backup.ts `parseDiffChanges`). A snapshot that differs from the last
      // one in nothing under the targets is dropped again.
      const state = readState();
      const previous = state.lastSnapshot;
      if (out.snapshot && previous && previous !== out.snapshot) {
        const diff = await runRestic(restic.path, diffArgs(previous, out.snapshot), env);
        if (diff.code === 0 && parseDiffChanges(diff.stdout) === 0) {
          const dropped = await runRestic(restic.path, forgetOneArgs(out.snapshot), env);
          if (dropped.code !== 0) log(`[backup] could not drop the unchanged snapshot ${out.snapshot.slice(0, 8)}: ${resticSaid(dropped)}`);
          else out.snapshot = null;
        }
      }
      // Old snapshots are left alone until this machine has one of its own
      // here, so a machine that joined the repository can restore first
      // (backup.ts `forgetDue`).
      const thin = forgetDue(state);
      const prune = thin && pruneDue(state, at);
      if (!thin) log("[backup] the first backup from this machine: the snapshots already in the repository are left as they are");
      const forgot = thin ? await runRestic(restic.path, forgetArgs(prune), env) : null;
      if (forgot && forgot.code !== 0) {
        // The snapshot is in the repository. The failure is recorded so
        // `status` shows it; the snapshot is recorded so a restore finds it.
        const error = `snapshot ${out.snapshot?.slice(0, 8) ?? "kept"}, but restic forget failed: ${resticSaid(forgot)}`;
        log(`[backup] ${error}`);
        writeState(recordRun(readState(), { at, ok: false, error, snapshot: out.snapshot, skipped }));
        return { ok: false as const, error, skipped };
      }
      writeState(recordRun(readState(), { at, ok: true, snapshot: out.snapshot, pruned: prune, skipped }));
      log(`[backup] ${out.snapshot ? `snapshot ${out.snapshot.slice(0, 8)}` : "nothing changed since the last snapshot"}${prune ? "; pruned" : ""}`);
      return { ok: true as const, snapshot: out.snapshot, changed: out.snapshot !== null, pruned: prune, skipped, errors: out.errors };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  if ("busy" in locked) return { ok: false, error: `a backup is already running (pid ${locked.busy})`, busy: locked.busy };
  return locked.result;
}

/** The newest snapshots Ledge took, newest first. */
export async function listSnapshots(limit = 20): Promise<{ snapshots: SnapshotInfo[] } | { error: string }> {
  const config = configured();
  if (!config) return { error: "backups are not set up on this machine: run `ledge backup setup`" };
  const restic = await findRestic();
  if ("missing" in restic) return { error: restic.missing };
  const r = await runRestic(restic.path, ["snapshots", "--json", "--tag", "ledge", "--latest", String(limit)], resticEnv(config));
  if (r.code !== 0) return { error: `restic snapshots failed: ${resticSaid(r)}` };
  return { snapshots: parseSnapshots(r.stdout).sort((a, b) => b.time.localeCompare(a.time)) };
}

// --- the daemon's schedule ---------------------------------------------------

export interface BackupScheduler {
  /** Start the hourly tick, and an overdue run soon after. */
  start(): void;
  stop(): void;
  /** The daemon's last act before an idle exit: a backup, when one is worth it. */
  beforeIdleExit(): Promise<void>;
}

/**
 * The daemon's backup schedule (remote.md §11). It ticks every hour whether
 * or not backups are set up, and asks at each tick, so a `setup` run while
 * the daemon is up takes effect without a restart. A run that is already
 * going (a `now` typed by hand) is left alone.
 */
export function backupScheduler(
  o: { log: Log; everyMs?: number; idleGapMs?: number; startDelayMs?: number; now?: () => Date } = { log: () => {} },
): BackupScheduler {
  const every = o.everyMs ?? BACKUP_EVERY_MS;
  const now = o.now ?? (() => new Date());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const run = (reason: string): Promise<void> => {
    if (running) return running;
    running = runBackup({ log: o.log, reason })
      .then((r) => {
        if (!r.ok && !("unconfigured" in r) && !("busy" in r)) o.log(`[backup] ${reason}: ${r.error}`);
      })
      .catch((err) => o.log(`[backup] ${reason}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => (running = null));
    return running;
  };

  const arm = (ms: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, ms);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (configured() && isOverdue(readState(), now(), every)) await run("scheduled");
    if (stopped) return;
    arm(Math.max(1_000, nextDue(readState(), now(), every).getTime() - now().getTime()));
  };

  return {
    start() {
      // A moment after boot, so a restart during an outage retries then rather
      // than in the middle of the daemon's own startup.
      arm(o.startDelayMs ?? 5_000);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    async beforeIdleExit() {
      if (!configured()) return;
      if (!idleExitWorthIt(readState(), now(), o.idleGapMs)) return;
      await run("before idle exit");
    },
  };
}
