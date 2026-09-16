// The backup's I/O (backupRun.ts) against a fake restic: a shell script first
// on the PATH that records what it was asked and answers from environment
// variables. What the real restic makes of those command lines is
// scripts/probe-backup.ts's claim, against a bucket. The scratch app home and
// profiles dir come from the preload (src/test-preload.ts).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_STATE, KEEP, recordRun, RESTIC_VERSION } from "./backup";
import {
  BACKUP_DIR,
  backupScheduler,
  fetchRestic,
  fetchedResticPath,
  findRestic,
  LOCK_PATH,
  PROFILE_PATH,
  readState,
  runBackup,
  STATE_PATH,
  writeState,
} from "./backupRun";
import { loadWorkspaces, APP_HOME } from "./workspaces";
import { PROFILES_DIR } from "./spawnParams";

const FAKE_DIR = await mkdtemp(join(tmpdir(), "ledge-fake-restic-"));
const FAKE = join(FAKE_DIR, "restic");
const ARGLOG = join(FAKE_DIR, "args.log");
const ORIGINAL_PATH = process.env["PATH"] ?? "";

// The fake answers each subcommand from FAKE_* variables, so a test sets the
// scene in process.env (the spawn inherits it) rather than in the script.
writeFileSync(
  FAKE,
  `#!/bin/sh
printf '%s\\n' "$*" >> "${ARGLOG}"
case "$1" in
  version) echo "restic \${FAKE_VERSION:-${RESTIC_VERSION}} compiled with go1.24 on fake/arch" ;;
  backup)
    [ -n "$FAKE_BACKUP_FAIL" ] && { echo "Fatal: $FAKE_BACKUP_FAIL" >&2; exit 1; }
    echo '{"message_type":"status","percent_done":1}'
    echo "{\\"message_type\\":\\"summary\\",\\"snapshot_id\\":\\"$FAKE_SNAPSHOT\\"}" ;;
  diff) printf '%s' "$FAKE_DIFF" ;;
  forget) [ -n "$FAKE_FORGET_FAIL" ] && { echo "Fatal: $FAKE_FORGET_FAIL" >&2; exit 1; } ;;
  snapshots) printf '%s' "\${FAKE_SNAPSHOTS:-[]}" ;;
  *) ;;
esac
exit 0
`,
);
chmodSync(FAKE, 0o755);

const WS = join(APP_HOME, "Notes");
const EXTERNAL = join(APP_HOME, "..", "attached-for-backup-test");

const argLines = (): string[][] => (existsSync(ARGLOG) ? readFileSync(ARGLOG, "utf8").trim().split("\n").map((l) => l.split(" ")) : []);
const calls = (verb: string) => argLines().filter((a) => a[0] === verb);
const clearLog = () => rmSync(ARGLOG, { force: true });

function configure(vars: Record<string, string> = {}): void {
  mkdirSync(PROFILES_DIR, { recursive: true });
  const all = { RESTIC_REPOSITORY: "s3:http://127.0.0.1:1/bucket", RESTIC_PASSWORD: "pw", AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "s", ...vars };
  writeFileSync(PROFILE_PATH, Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

beforeAll(async () => {
  process.env["PATH"] = `${FAKE_DIR}:${ORIGINAL_PATH}`;
  mkdirSync(WS, { recursive: true });
  mkdirSync(EXTERNAL, { recursive: true });
  writeFileSync(join(APP_HOME, ".workspaces.json"), JSON.stringify({ version: 1, roots: [WS, EXTERNAL] }));
  await loadWorkspaces();
});

afterEach(() => {
  clearLog();
  for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
  rmSync(STATE_PATH, { force: true });
  rmSync(LOCK_PATH, { force: true });
  rmSync(PROFILE_PATH, { force: true });
});

afterAll(async () => {
  process.env["PATH"] = ORIGINAL_PATH;
  await rm(FAKE_DIR, { recursive: true, force: true });
  await rm(EXTERNAL, { recursive: true, force: true });
});

describe("finding restic", () => {
  test("a restic on the PATH that is new enough is the one used", async () => {
    const found = await findRestic();
    expect(found).toEqual({ path: FAKE, version: RESTIC_VERSION });
  });

  test("a restic on the PATH that is too old is passed over, and without a fetch nothing serves", async () => {
    process.env["FAKE_VERSION"] = "0.16.4";
    const found = await findRestic();
    expect("missing" in found && found.missing).toContain("too old");
  });
});

describe("one run", () => {
  test("not set up: says so, runs nothing, writes no state", async () => {
    const r = await runBackup({ reason: "test" });
    expect(r.ok).toBe(false);
    expect("unconfigured" in r).toBe(true);
    expect(calls("backup")).toHaveLength(0);
    expect(existsSync(STATE_PATH)).toBe(false);
  });

  test("a run hands restic both lists, tags and skips, and records the snapshot", async () => {
    configure();
    process.env["FAKE_SNAPSHOT"] = "abc123";
    const log: string[] = [];
    const r = await runBackup({ reason: "test", log: (l) => log.push(l) });
    expect(r).toMatchObject({ ok: true, snapshot: "abc123", changed: true, skipped: [] });

    const backup = calls("backup")[0]!;
    expect(backup).toContain("--skip-if-unchanged");
    expect(backup.slice(backup.indexOf("--tag") + 1)[0]).toBe("ledge");
    // The list files are gone by now (they lived under BACKUP_DIR for the
    // run), so their contents are checked through what the state and the
    // arguments say: an include and an exclude file, both under BACKUP_DIR.
    expect(backup[backup.indexOf("--files-from") + 1]).toStartWith(BACKUP_DIR);
    expect(backup[backup.indexOf("--exclude-file") + 1]).toStartWith(BACKUP_DIR);
    expect(existsSync(backup[backup.indexOf("--files-from") + 1]!)).toBe(false);

    const state = readState();
    expect(state.lastSnapshot).toBe("abc123");
    expect(state.lastOk).toBe(state.lastRun);
    expect(log.some((l) => l.includes("snapshot abc123"))).toBe(true);
  });

  test("the first run from a machine with no snapshot of its own here leaves the older ones alone", async () => {
    // The restore window: a machine that joined the repository backs up
    // before it restores, and thinning around that would drop the snapshot
    // it is about to ask for (backup.ts `forgetDue`).
    configure();
    process.env["FAKE_SNAPSHOT"] = "abc123";
    const log: string[] = [];
    const r = await runBackup({ reason: "test", log: (l) => log.push(l) });
    expect(r).toMatchObject({ ok: true, snapshot: "abc123", pruned: false });
    expect(calls("forget")).toHaveLength(0);
    expect(readState().lastPrune).toBeNull();
    expect(log.some((l) => l.includes("the first backup from this machine"))).toBe(true);
  });

  test("a later run thins with the policy and prunes the first time", async () => {
    configure();
    writeState(recordRun(EMPTY_STATE, { at: new Date(Date.now() - 3_600_000), ok: true, snapshot: "old1", skipped: [] }));
    process.env["FAKE_SNAPSHOT"] = "abc123";
    process.env["FAKE_DIFF"] = '{"message_type":"change","path":"/x/a.md","modifier":"M"}\n{"message_type":"statistics"}\n';
    const r = await runBackup({ reason: "test" });
    expect(r).toMatchObject({ ok: true, snapshot: "abc123", pruned: true });

    const forget = calls("forget")[0]!;
    expect(forget).toContain("--prune");
    expect(forget[forget.indexOf("--keep-last") + 1]).toBe(String(KEEP.last));
    expect(forget[forget.indexOf("--keep-hourly") + 1]).toBe(String(KEEP.hourly));
    expect(forget.slice(forget.indexOf("--tag") + 1)[0]).toBe("ledge");
    expect(readState().lastPrune).toBe(readState().lastRun);
  });

  test("the include list names the app home, the attached root and the profiles; the excludes name .server", async () => {
    configure();
    process.env["FAKE_SNAPSHOT"] = "abc123";
    // The fake copies the lists before the run deletes them.
    writeFileSync(
      FAKE,
      readFileSync(FAKE, "utf8").replace(
        "  backup)\n",
        `  backup)\n    while [ $# -gt 0 ]; do case "$1" in --files-from) cp "$2" "${FAKE_DIR}/include";; --exclude-file) cp "$2" "${FAKE_DIR}/exclude";; esac; shift; done\n`,
      ),
    );
    await runBackup({ reason: "test" });
    const include = readFileSync(join(FAKE_DIR, "include"), "utf8").trim().split("\n");
    const exclude = readFileSync(join(FAKE_DIR, "exclude"), "utf8").trim().split("\n");
    expect(include).toEqual([APP_HOME, EXTERNAL, PROFILES_DIR]);
    expect(exclude).toContain(join(APP_HOME, ".server"));
    expect(exclude).toContain(join(APP_HOME, "logs"));
  });

  test("--no-secrets leaves the profiles dir out", async () => {
    configure();
    process.env["FAKE_SNAPSHOT"] = "abc123";
    await runBackup({ reason: "test", secrets: false });
    expect(readFileSync(join(FAKE_DIR, "include"), "utf8")).not.toContain(PROFILES_DIR);
  });

  test("an unchanged tree makes no snapshot and keeps the last one", async () => {
    configure();
    writeState(recordRun(EMPTY_STATE, { at: new Date(Date.now() - 3_600_000), ok: true, snapshot: "old1", pruned: true, skipped: [] }));
    process.env["FAKE_SNAPSHOT"] = "";
    const r = await runBackup({ reason: "test" });
    expect(r).toMatchObject({ ok: true, snapshot: null, changed: false, pruned: false });
    expect(readState().lastSnapshot).toBe("old1");
    expect(calls("diff")).toHaveLength(0);
  });

  test("a snapshot that differs from the last in nothing under the targets is dropped again", async () => {
    // What a busy parent folder does to restic's own unchanged check
    // (backup.ts `parseDiffChanges`).
    configure();
    writeState(recordRun(EMPTY_STATE, { at: new Date(), ok: true, snapshot: "old1", pruned: true, skipped: [] }));
    process.env["FAKE_SNAPSHOT"] = "spurious";
    process.env["FAKE_DIFF"] = '{"message_type":"statistics","changed_files":0}\n';
    const r = await runBackup({ reason: "test" });
    expect(r).toMatchObject({ ok: true, snapshot: null, changed: false });
    expect(calls("diff")[0]).toEqual(["diff", "--json", "old1", "spurious"]);
    expect(calls("forget").map((a) => a[1])).toContain("spurious");
    expect(readState().lastSnapshot).toBe("old1");
  });

  test("a snapshot whose diff lists a change is kept and recorded", async () => {
    configure();
    writeState(recordRun(EMPTY_STATE, { at: new Date(), ok: true, snapshot: "old1", pruned: true, skipped: [] }));
    process.env["FAKE_SNAPSHOT"] = "real2";
    process.env["FAKE_DIFF"] = '{"message_type":"change","path":"/x/a.md","modifier":"M"}\n{"message_type":"statistics"}\n';
    const r = await runBackup({ reason: "test" });
    expect(r).toMatchObject({ ok: true, snapshot: "real2", changed: true });
    expect(calls("forget").map((a) => a[1])).not.toContain("real2");
    expect(readState().lastSnapshot).toBe("real2");
  });

  test("a failed backup is recorded with restic's words and makes no forget call", async () => {
    configure();
    process.env["FAKE_BACKUP_FAIL"] = "unable to open repository: no route to host";
    const r = await runBackup({ reason: "test" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("no route to host");
    expect(calls("forget")).toHaveLength(0);
    const state = readState();
    expect(state.lastError).toContain("no route to host");
    expect(state.lastOk).toBeNull();
  });

  test("a forget that fails after the snapshot landed records both", async () => {
    configure();
    writeState(recordRun(EMPTY_STATE, { at: new Date(), ok: true, snapshot: "old1", pruned: true, skipped: [] }));
    process.env["FAKE_SNAPSHOT"] = "kept1";
    process.env["FAKE_DIFF"] = '{"message_type":"change","path":"/x/a.md","modifier":"M"}\n{"message_type":"statistics"}\n';
    process.env["FAKE_FORGET_FAIL"] = "repository is already locked";
    const r = await runBackup({ reason: "test" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("kept1");
    expect(readState().lastSnapshot).toBe("kept1");
    expect(readState().lastError).toContain("already locked");
  });

  test("a registered root that is not on disk is skipped, said, and recorded", async () => {
    configure();
    process.env["FAKE_SNAPSHOT"] = "abc";
    rmSync(EXTERNAL, { recursive: true, force: true });
    try {
      const log: string[] = [];
      const r = await runBackup({ reason: "test", log: (l) => log.push(l) });
      expect(r).toMatchObject({ ok: true, skipped: [EXTERNAL] });
      expect(log.some((l) => l.includes(`skipping ${EXTERNAL}`))).toBe(true);
      expect(readState().skipped.map((s) => s.root)).toEqual([EXTERNAL]);
      expect(readFileSync(join(FAKE_DIR, "include"), "utf8")).not.toContain(EXTERNAL);
    } finally {
      mkdirSync(EXTERNAL, { recursive: true });
    }
  });

  test("a second run while one holds the lock is refused with the holder's pid; a dead holder's lock is taken", async () => {
    configure();
    process.env["FAKE_SNAPSHOT"] = "abc";
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(LOCK_PATH, String(process.pid));
    const busy = await runBackup({ reason: "test" });
    expect(busy.ok).toBe(false);
    expect("busy" in busy && busy.busy).toBe(process.pid);
    expect(calls("backup")).toHaveLength(0);

    writeFileSync(LOCK_PATH, "999999");
    const taken = await runBackup({ reason: "test" });
    expect(taken.ok).toBe(true);
    expect(existsSync(LOCK_PATH)).toBe(false);
  });
});

describe("fetching restic", () => {
  // A release "mirror" that is a directory, reached over file://, holding a
  // bzip2 of a fake restic: the download, the checksum and the unpack run for
  // real, without GitHub and without opening a port (ports.test.ts).
  const script = `#!/bin/sh\necho "restic 9.9.9 compiled for the test"\n`;
  let packed: Uint8Array<ArrayBuffer>;
  let mirror: string;

  beforeAll(async () => {
    const p = Bun.spawn(["bzip2", "-c"], { stdin: new TextEncoder().encode(script), stdout: "pipe" });
    packed = new Uint8Array(await new Response(p.stdout).arrayBuffer());
    const dir = join(FAKE_DIR, "mirror", `v${RESTIC_VERSION}`);
    mkdirSync(dir, { recursive: true });
    const goArch = process.arch === "x64" ? "amd64" : "arm64";
    writeFileSync(join(dir, `restic_${RESTIC_VERSION}_${process.platform}_${goArch}.bz2`), packed);
    mirror = `file://${join(FAKE_DIR, "mirror")}`;
  });

  const sha = () => new Bun.CryptoHasher("sha256").update(packed).digest("hex");

  test("the pinned sum must match, or nothing is installed", async () => {
    const dest = fetchedResticPath("test-bad");
    await expect(fetchRestic({ dest, releases: mirror, sha256: "0".repeat(64) })).rejects.toThrow(/SHA-256/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.bz2.tmp-${process.pid}`)).toBe(false);
  });

  test("a matching sum unpacks an executable into place", async () => {
    const dest = fetchedResticPath("test-good");
    const log: string[] = [];
    await fetchRestic({ dest, releases: mirror, sha256: sha(), log: (l) => log.push(l) });
    expect(statSync(dest).mode & 0o111).not.toBe(0);
    expect(readFileSync(dest, "utf8")).toBe(script);
    expect(log.some((l) => l.includes("installed"))).toBe(true);
    rmSync(dest, { force: true });
  });

  test("a platform off the four is refused before any download", async () => {
    await expect(fetchRestic({ dest: fetchedResticPath("x"), platform: "win32", arch: "x64", releases: mirror })).rejects.toThrow(/no restic release is pinned/);
  });
});

describe("the daemon's schedule", () => {
  test("a tick runs when a backup is overdue, and the idle-exit run honors the gap", async () => {
    configure();
    process.env["FAKE_SNAPSHOT"] = "tick1";
    const log: string[] = [];
    const s = backupScheduler({ log: (l) => log.push(l), everyMs: 200, startDelayMs: 10 });
    s.start();
    await Bun.sleep(150);
    expect(calls("backup")).toHaveLength(1);
    expect(readState().lastSnapshot).toBe("tick1");

    // Just backed up: an idle exit right now does nothing.
    await s.beforeIdleExit();
    expect(calls("backup")).toHaveLength(1);
    // With the gap gone, it runs.
    const late = backupScheduler({ log: (l) => log.push(l), idleGapMs: 0 });
    process.env["FAKE_SNAPSHOT"] = "";
    await late.beforeIdleExit();
    expect(calls("backup")).toHaveLength(2);
    s.stop();
  });

  test("not set up: the scheduler ticks quietly and the idle exit runs nothing", async () => {
    const s = backupScheduler({ log: () => {}, everyMs: 50, startDelayMs: 5 });
    s.start();
    await Bun.sleep(80);
    await s.beforeIdleExit();
    s.stop();
    expect(calls("backup")).toHaveLength(0);
  });
});
