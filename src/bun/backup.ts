// The backup policy in pure functions, testable without a filesystem, a
// server or a network (testing.md §2): which paths a backup of this machine
// covers, what the `backup` profile has to hold, which restic release Ledge
// fetches, the command lines it runs, and the state one run leaves for the
// next. backupRun.ts does the I/O and backupCli.ts answers the verbs.
// remote.md §11 has the design and the reasons.
import { join } from "node:path";
import { parseDotenv } from "../shared/dotenv";
import { isInside } from "./workspaces";

// --- 1. The backup set -------------------------------------------------------

export interface BackupSet {
  /** Absolute paths to back up. */
  include: string[];
  /** Absolute paths inside those that must not travel. */
  exclude: string[];
}

export interface BackupInput {
  appHome: string;
  profilesDir: string;
  /** The registered roots that are on disk. A root on an unmounted volume is
   * left out and reported by the caller: naming a path that is not there
   * fails the whole restic run, and dropping it silently takes a workspace
   * out of the backup set until someone tries to restore it. */
  roots: readonly string[];
  /** Whether to include the profiles dir. False is for a caller that backs
   * its secrets up elsewhere. Profiles sit outside the app home to keep
   * credentials out of the folder people sync (architecture.md §6a). A
   * backup without them restores notes that name a profile but not the
   * values. Those blocks then spawn with a warning (spawnParams.ts). */
  secrets: boolean;
}

/**
 * The include and exclude sets for one machine.
 *
 * Roots the app home already covers are dropped: managed workspaces are its
 * direct children, and the docs root sits inside it. Duplicate include paths
 * are dropped as well: restic would otherwise walk the same path twice.
 */
export function backupSet(input: BackupInput): BackupSet {
  const { appHome, profilesDir, roots, secrets } = input;

  const include = [appHome];
  // External roots only. A managed root is under the app home; so is
  // .ledge-docs, which the excludes drop again below.
  for (const root of roots) if (!isInside(appHome, root)) include.push(root);
  // Last, so the ordinary case reads as "notes, then the secrets beside them".
  if (secrets && !include.some((p) => isInside(p, profilesDir))) include.push(profilesDir);

  return { include: unique(include), exclude: excludesFor(appHome) };
}

/**
 * The app-home entries a backup skips, and why each one:
 *
 * | Entry | Why |
 * | --- | --- |
 * | `.server.sock` | A unix socket. Not a file, not restorable, and archivers disagree about what to do with one. |
 * | `.server.pid` | Names a process on the machine being backed up, so it is wrong once it is restored anywhere. |
 * | `logs/` | One session's diagnostics, rotated and size-capped (log.ts). A restore has no use for old console output. |
 * | `.ledge-docs/` | The built-in manual, written out of the compiled-in corpus at every launch (bun/docs.ts). Backing it up stores a second copy of bytes that ship inside the binary. |
 * | `.server/` | The installed server and its private Bun (remote.md §11), the restic Ledge fetched, its cache, and the backup's own state and lock. On a Mac it holds the app's `ledge` launcher as well. |
 */
function excludesFor(appHome: string): string[] {
  return [".server.sock", ".server.pid", "logs", ".ledge-docs", ".server"].map((name) => join(appHome, name));
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

// --- 2. The `backup` profile -------------------------------------------------

/** The profile that holds the repository and its credentials. A note with
 * `profile: backup` runs restic by hand with the same variables. */
export const BACKUP_PROFILE = "backup";

/** What every restic backend needs. */
const ALWAYS = ["RESTIC_REPOSITORY", "RESTIC_PASSWORD"] as const;
/** What an `s3:` repository needs on top: the bucket's key pair. */
const S3_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const;

export interface BackupConfig {
  repository: string;
  /** Every variable in the profile, for restic's environment. */
  env: Record<string, string>;
}

export type ConfigRead = { config: BackupConfig; problems: string[] } | { missing: string[]; problems: string[] };

/** Read the profile's text into a config, or the names it still lacks. `null` is no file. */
export function parseBackupConfig(text: string | null): ConfigRead {
  if (text === null) return { missing: [...ALWAYS], problems: [] };
  const { vars, problems } = parseDotenv(text);
  const need: string[] = [...ALWAYS];
  if (vars["RESTIC_REPOSITORY"]?.startsWith("s3:")) need.push(...S3_KEYS);
  const missing = need.filter((k) => !vars[k]);
  if (missing.length > 0) return { missing, problems };
  return { config: { repository: vars["RESTIC_REPOSITORY"]!, env: vars }, problems };
}

/** A restic repository address for a bucket on an S3-compatible endpoint. */
export function s3Repository(endpoint: string, bucket: string): string {
  return `s3:${endpoint.trim().replace(/\/+$/, "")}/${bucket.trim().replace(/^\/+|\/+$/g, "")}`;
}

/** The profile file `setup` writes. Values are written plain: the parser
 * takes everything after the `=`, so a secret with `/`, `+` or `=` needs no
 * quoting, and one with edge whitespace gets double quotes. */
export function backupProfileText(vars: Record<string, string>): string {
  const lines = [
    `# Ledge profile "${BACKUP_PROFILE}": the backup repository and its credentials.`,
    `# Written by \`ledge backup setup\`. Every \`ledge backup\` verb reads it, and so does`,
    `# any note whose frontmatter says: profile: ${BACKUP_PROFILE}`,
    `# RESTIC_PASSWORD is the only key to the backup. Keep a copy somewhere else.`,
    ``,
  ];
  for (const [key, value] of Object.entries(vars)) {
    const quoted = value !== value.trim() || /^["']/.test(value) ? `"${value.replace(/["\\]/g, "\\$&")}"` : value;
    lines.push(`${key}=${quoted}`);
  }
  lines.push(``);
  return lines.join("\n");
}

// --- 3. The restic release ---------------------------------------------------

/** The restic every machine gets when none is installed. Bumping it means
 * re-reading the four sums from that release's SHA256SUMS. */
export const RESTIC_VERSION = "0.19.1";
/** The oldest restic `backup now` accepts from the PATH: `--skip-if-unchanged` arrived in 0.17.0. */
export const RESTIC_MIN_VERSION = "0.17.0";
/** Where the release assets live. `LEDGE_RESTIC_RELEASES` replaces it for a mirror. */
export const RESTIC_RELEASES = "https://github.com/restic/restic/releases/download";

/** SHA-256 of each target's `.bz2`, from the release's signed SHA256SUMS. */
export const RESTIC_SHA256: Readonly<Record<string, string>> = {
  "darwin-arm64": "7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143",
  "darwin-x64": "c38d579622cf602f665234c5a8c315030b6cf70656028fe6dc29a786b60e5f35",
  "linux-arm64": "a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465",
  "linux-x64": "f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c",
};

export interface ResticAsset {
  file: string;
  url: string;
  sha256: string;
}

/** The release file for a platform and arch as Bun names them, or null off the four targets. */
export function resticAsset(platform: string, arch: string, base = RESTIC_RELEASES): ResticAsset | null {
  const goArch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  const sha256 = RESTIC_SHA256[`${platform}-${arch}`];
  if (!goArch || !sha256) return null;
  const file = `restic_${RESTIC_VERSION}_${platform}_${goArch}.bz2`;
  return { file, url: `${base.replace(/\/+$/, "")}/v${RESTIC_VERSION}/${file}`, sha256 };
}

/** The version `restic version` printed, or null for anything else. */
export function resticVersionOf(text: string): string | null {
  return /\brestic (\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// --- 4. Schedule, retention and state ---------------------------------------

/** How often the daemon backs up while it is running. */
export const BACKUP_EVERY_MS = 60 * 60 * 1000;
/** How often `forget` also prunes. Pruning rewrites packs and is the
 * expensive half; thinning the snapshot list every hour is cheap. */
export const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
/** An idle-exit backup is skipped when the last good one is younger than this. */
export const IDLE_EXIT_MIN_GAP_MS = 10 * 60 * 1000;
/** Snapshots kept: a day of hourlies, a month of dailies, a quarter of weeklies, two years of monthlies. */
export const KEEP = { hourly: 24, daily: 30, weekly: 12, monthly: 24 } as const;
/** The tag on every snapshot Ledge takes, so `forget` thins only those. */
export const SNAPSHOT_TAG = "ledge";

export interface BackupState {
  version: 1;
  /** When the last run started, whatever came of it. */
  lastRun: string | null;
  /** When the last run that succeeded started. */
  lastOk: string | null;
  /** What the last run said when it failed; null after a success. */
  lastError: string | null;
  /** The snapshot the last good run made, or kept when nothing had changed. */
  lastSnapshot: string | null;
  lastPrune: string | null;
  /** Registered roots the last run left out, and the first run that did. */
  skipped: Array<{ root: string; since: string }>;
}

export const EMPTY_STATE: BackupState = {
  version: 1,
  lastRun: null,
  lastOk: null,
  lastError: null,
  lastSnapshot: null,
  lastPrune: null,
  skipped: [],
};

/** The state file's text as a state, tolerating a missing or damaged file. */
export function parseState(text: string | null): BackupState {
  if (text === null) return EMPTY_STATE;
  try {
    const raw = JSON.parse(text) as Partial<BackupState>;
    if (raw.version !== 1) return EMPTY_STATE;
    return {
      ...EMPTY_STATE,
      ...raw,
      skipped: Array.isArray(raw.skipped) ? raw.skipped.filter((s) => typeof s?.root === "string" && typeof s?.since === "string") : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

export interface RunOutcome {
  at: Date;
  ok: boolean;
  error?: string;
  /** The snapshot made, or null when nothing changed and none was. */
  snapshot?: string | null;
  pruned?: boolean;
  /** Registered roots that were not on disk. */
  skipped: readonly string[];
}

/** The state after one run. A skipped root keeps its first `since`. */
export function recordRun(prev: BackupState, o: RunOutcome): BackupState {
  const at = o.at.toISOString();
  const since = new Map(prev.skipped.map((s) => [s.root, s.since]));
  return {
    version: 1,
    lastRun: at,
    lastOk: o.ok ? at : prev.lastOk,
    lastError: o.ok ? null : (o.error ?? "failed"),
    // Recorded whenever one was made, ok or not: a `forget` that failed
    // after the snapshot landed leaves a snapshot a restore should find.
    lastSnapshot: o.snapshot ?? prev.lastSnapshot,
    lastPrune: o.pruned ? at : prev.lastPrune,
    skipped: o.skipped.map((root) => ({ root, since: since.get(root) ?? at })),
  };
}

/** When the next scheduled run is due: an hour after the last one, or now. */
export function nextDue(state: BackupState, now: Date, every = BACKUP_EVERY_MS): Date {
  if (!state.lastRun) return now;
  return new Date(Math.max(now.getTime(), Date.parse(state.lastRun) + every));
}

export function isOverdue(state: BackupState, now: Date, every = BACKUP_EVERY_MS): boolean {
  return nextDue(state, now, every).getTime() <= now.getTime();
}

export function pruneDue(state: BackupState, now: Date, every = PRUNE_EVERY_MS): boolean {
  return !state.lastPrune || Date.parse(state.lastPrune) + every <= now.getTime();
}

/** Whether an idle exit should back up first: yes unless a good run is recent. */
export function idleExitWorthIt(state: BackupState, now: Date, gap = IDLE_EXIT_MIN_GAP_MS): boolean {
  return !state.lastOk || Date.parse(state.lastOk) + gap <= now.getTime();
}

// --- 5. restic command lines -------------------------------------------------

export function backupArgs(o: { filesFrom: string; excludeFile: string }): string[] {
  return [
    "backup",
    "--files-from",
    o.filesFrom,
    "--exclude-file",
    o.excludeFile,
    "--tag",
    SNAPSHOT_TAG,
    "--skip-if-unchanged",
    "--json",
  ];
}

export function forgetArgs(prune: boolean): string[] {
  return [
    "forget",
    "--tag",
    SNAPSHOT_TAG,
    "--keep-hourly",
    String(KEEP.hourly),
    "--keep-daily",
    String(KEEP.daily),
    "--keep-weekly",
    String(KEEP.weekly),
    "--keep-monthly",
    String(KEEP.monthly),
    ...(prune ? ["--prune"] : []),
    "--quiet",
  ];
}

/** `diff --json` between the previous snapshot and the one just made. */
export function diffArgs(parent: string, snapshot: string): string[] {
  return ["diff", "--json", parent, snapshot];
}

/** Drop one snapshot, without pruning: a spurious one is a few tree blobs. */
export function forgetOneArgs(snapshot: string): string[] {
  return ["forget", snapshot, "--quiet"];
}

/**
 * How many files or directories `diff --json` listed as added, removed or
 * modified. restic's own `--skip-if-unchanged` compares whole trees, and a
 * tree carries the metadata of every ancestor of a target, so a busy parent
 * folder (a home directory, a temp dir) makes an unchanged target look
 * changed. A diff lists only what is under the targets.
 */
export function parseDiffChanges(stdout: string): number {
  let changes = 0;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      if ((JSON.parse(line) as { message_type?: string }).message_type === "change") changes++;
    } catch {
      // A line that is not JSON is not a change.
    }
  }
  return changes;
}

export function restoreArgs(o: { snapshot: string; target: string; include: readonly string[] }): string[] {
  return ["restore", o.snapshot, "--target", o.target, ...o.include.flatMap((p) => ["--include", p])];
}

export interface BackupOutput {
  /** The snapshot the run made; null when `--skip-if-unchanged` made none. */
  snapshot: string | null;
  /** Error messages restic reported per file, if any. */
  errors: string[];
}

/** What `backup --json` said: one summary line among the progress lines. */
export function parseBackupOutput(stdout: string): BackupOutput {
  let snapshot: string | null = null;
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let msg: { message_type?: string; snapshot_id?: string; error?: { message?: string }; item?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.message_type === "summary") {
      const id = msg.snapshot_id ?? "";
      snapshot = id === "" || /^0+$/.test(id) ? null : id;
    } else if (msg.message_type === "error") {
      errors.push(`${msg.item ?? ""}: ${msg.error?.message ?? "error"}`.replace(/^: /, ""));
    }
  }
  return { snapshot, errors };
}

/** One `snapshots --json` entry, the fields `status` and `restore` use. */
export interface SnapshotInfo {
  short_id: string;
  time: string;
  hostname: string;
  paths: string[];
}

export function parseSnapshots(stdout: string): SnapshotInfo[] {
  try {
    const raw = JSON.parse(stdout) as Array<Partial<SnapshotInfo>>;
    return raw
      .filter((s) => typeof s.short_id === "string" && typeof s.time === "string")
      .map((s) => ({ short_id: s.short_id!, time: s.time!, hostname: s.hostname ?? "", paths: s.paths ?? [] }));
  } catch {
    return [];
  }
}

// --- 6. What `status` prints -------------------------------------------------

export interface StatusInput {
  repository: string | null;
  /** The restic that will run, or what is wrong with it. */
  restic: { path: string; version: string } | { missing: string };
  state: BackupState;
  daemonUp: boolean;
  now: Date;
}

/** `status` as lines, so the CLI prints them and a test reads them. */
export function statusLines(s: StatusInput): string[] {
  const lines: string[] = [];
  lines.push(`repository   ${s.repository ?? "none: run `ledge backup setup`"}`);
  lines.push(`restic       ${"path" in s.restic ? `${s.restic.version} at ${s.restic.path}` : s.restic.missing}`);
  const { state, now } = s;
  if (!state.lastRun) lines.push(`last backup  never`);
  else if (state.lastOk === state.lastRun) lines.push(`last backup  ${ago(state.lastRun, now)}, ok${state.lastSnapshot ? ` (snapshot ${state.lastSnapshot.slice(0, 8)})` : ""}`);
  else {
    lines.push(`last backup  ${ago(state.lastRun, now)}, FAILED: ${state.lastError ?? "unknown"}`);
    lines.push(`last good    ${state.lastOk ? ago(state.lastOk, now) : "never"}`);
  }
  if (s.repository) {
    lines.push(
      s.daemonUp
        ? `next backup  ${nextDue(state, now).getTime() <= now.getTime() ? "due now" : `in ${duration(nextDue(state, now).getTime() - now.getTime())}`} (the server is running)`
        : `next backup  when the server next runs, and hourly while it does`,
    );
  }
  for (const k of state.skipped) lines.push(`SKIPPED      ${k.root} (not on disk since ${ago(k.since, now)})`);
  return lines;
}

export function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  if (ms < 60_000) return "just now";
  return `${duration(ms)} ago`;
}

export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days`;
}
