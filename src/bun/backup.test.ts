// The backup policy's rules (backup.ts). Everything here is pure: no
// filesystem, no registry, no restic, so these tests need none either
// (testing.md §2). backupRun.fs.test.ts drives the I/O with a fake restic,
// and scripts/probe-backup.ts drives the real one against a bucket.
import { describe, expect, test } from "bun:test";
import {
  backupArgs,
  backupProfileText,
  diffArgs,
  forgetOneArgs,
  parseDiffChanges,
  backupSet,
  EMPTY_STATE,
  forgetArgs,
  forgetDue,
  idleExitWorthIt,
  isOverdue,
  KEEP,
  nextDue,
  parseBackupConfig,
  parseBackupOutput,
  parseSnapshots,
  parseState,
  pruneDue,
  recordRun,
  RESTIC_SHA256,
  RESTIC_VERSION,
  restoreArgs,
  resticAsset,
  resticVersionOf,
  s3Repository,
  statusLines,
  versionAtLeast,
} from "./backup";

const HOME = "/srv/ledge";
const PROFILES = "/root/.config/ledge/profiles";

function set(over: Partial<Parameters<typeof backupSet>[0]> = {}) {
  return backupSet({ appHome: HOME, profilesDir: PROFILES, roots: [], secrets: true, ...over });
}

describe("the backup set", () => {
  test("the app home is included whole, so new state in it is backed up by default", () => {
    expect(set().include).toContain(HOME);
  });

  test("profiles are included even though they live outside the app home", () => {
    // The bug this module exists for. A backup without this path restores the
    // notes that say `profile: prod` without the values they spawn with.
    expect(set().include).toContain(PROFILES);
  });

  test("--no-secrets drops the profiles dir and nothing else", () => {
    const withOut = set({ secrets: false });
    expect(withOut.include).not.toContain(PROFILES);
    expect(withOut.include).toEqual(set().include.filter((p) => p !== PROFILES));
  });

  test("external roots are included; managed roots are not, being inside the app home", () => {
    const { include } = set({ roots: [`${HOME}/scratch`, "/mnt/work/notes"] });
    expect(include).toContain("/mnt/work/notes");
    expect(include).not.toContain(`${HOME}/scratch`);
  });

  test("the docs root is not included: it is inside the app home and then excluded", () => {
    const { include, exclude } = set({ roots: [`${HOME}/.ledge-docs`] });
    expect(include).not.toContain(`${HOME}/.ledge-docs`);
    expect(exclude).toContain(`${HOME}/.ledge-docs`);
  });

  test("the socket, the pidfile, the logs, the docs and the installed server are excluded", () => {
    expect(set().exclude).toEqual([
      `${HOME}/.server.sock`,
      `${HOME}/.server.pid`,
      `${HOME}/logs`,
      `${HOME}/.ledge-docs`,
      `${HOME}/.server`,
    ]);
  });

  test("a root repeated in the registry is included once", () => {
    const { include } = set({ roots: ["/mnt/work/notes", "/mnt/work/notes"] });
    expect(include.filter((p) => p === "/mnt/work/notes")).toHaveLength(1);
  });

  test("a profiles dir already covered by a root is not added twice", () => {
    // LEDGE_PROFILES_DIR can point anywhere, including inside a root. Naming a
    // path twice makes restic walk it twice.
    const { include } = set({ roots: ["/mnt/work"], profilesDir: "/mnt/work/secrets" });
    expect(include).not.toContain("/mnt/work/secrets");
    expect(include).toContain("/mnt/work");
  });

  test("a profiles dir inside the app home is covered by it, not repeated", () => {
    const { include } = set({ profilesDir: `${HOME}/.profiles` });
    expect(include).toEqual([HOME]);
  });
});

describe("the backup profile", () => {
  const full = "RESTIC_REPOSITORY=s3:https://x.r2.cloudflarestorage.com/notes\nRESTIC_PASSWORD=pw\nAWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=secret\n";

  test("no file is not set up, and says which two variables every backend needs", () => {
    const read = parseBackupConfig(null);
    expect("missing" in read && read.missing).toEqual(["RESTIC_REPOSITORY", "RESTIC_PASSWORD"]);
  });

  test("an s3: repository needs the key pair as well", () => {
    const read = parseBackupConfig("RESTIC_REPOSITORY=s3:host/bucket\nRESTIC_PASSWORD=pw\n");
    expect("missing" in read && read.missing).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
  });

  test("a non-S3 repository needs only the address and the password", () => {
    const read = parseBackupConfig("RESTIC_REPOSITORY=sftp:user@host:/backups\nRESTIC_PASSWORD=pw\n");
    expect("config" in read && read.config.repository).toBe("sftp:user@host:/backups");
  });

  test("every variable in the file reaches restic's environment, export prefix and all", () => {
    const read = parseBackupConfig(`${full}export RESTIC_COMPRESSION=max\n`);
    expect("config" in read && read.config.env["RESTIC_COMPRESSION"]).toBe("max");
    expect("config" in read && read.config.env["AWS_SECRET_ACCESS_KEY"]).toBe("secret");
  });

  test("the text setup writes reads back as the same config", () => {
    const vars = { RESTIC_REPOSITORY: "s3:h/b", RESTIC_PASSWORD: "a/b+c=", AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: " odd " };
    const read = parseBackupConfig(backupProfileText(vars));
    expect("config" in read && read.config.env).toMatchObject(vars);
    expect(backupProfileText(vars)).toContain("profile: backup");
  });

  test("an S3 address is built from an endpoint and a bucket, with or without a scheme", () => {
    expect(s3Repository("s3.amazonaws.com", "notes")).toBe("s3:s3.amazonaws.com/notes");
    expect(s3Repository("https://acct.r2.cloudflarestorage.com/", "/notes/")).toBe("s3:https://acct.r2.cloudflarestorage.com/notes");
  });
});

describe("the restic release", () => {
  test("all four targets are pinned with a 64-hex sum and name the release's file", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
    ]) {
      const asset = resticAsset(platform!, arch!);
      expect(asset).not.toBeNull();
      expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset!.file).toBe(`restic_${RESTIC_VERSION}_${platform}_${arch === "x64" ? "amd64" : "arm64"}.bz2`);
      expect(asset!.url).toBe(`https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${asset!.file}`);
    }
    expect(Object.keys(RESTIC_SHA256)).toHaveLength(4);
  });

  test("a platform off the four is refused rather than guessed", () => {
    expect(resticAsset("win32", "x64")).toBeNull();
    expect(resticAsset("linux", "ia32")).toBeNull();
  });

  test("a mirror replaces the release host", () => {
    expect(resticAsset("linux", "x64", "https://mirror.example/restic/")!.url).toBe(`https://mirror.example/restic/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_amd64.bz2`);
  });

  test("the version is read out of `restic version`, and compared numerically", () => {
    expect(resticVersionOf("restic 0.19.1 compiled with go1.24.2 on darwin/arm64")).toBe("0.19.1");
    expect(resticVersionOf("bash: restic: command not found")).toBeNull();
    expect(versionAtLeast("0.17.0", "0.17.0")).toBe(true);
    expect(versionAtLeast("0.19.1", "0.17.0")).toBe(true);
    expect(versionAtLeast("0.9.6", "0.17.0")).toBe(false);
    expect(versionAtLeast("1.0.0", "0.17.0")).toBe(true);
  });
});

describe("schedule and state", () => {
  const t0 = new Date("2026-09-14T10:00:00Z");
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);

  test("a state file that is missing, damaged or of another version reads as empty", () => {
    expect(parseState(null)).toEqual(EMPTY_STATE);
    expect(parseState("{not json")).toEqual(EMPTY_STATE);
    expect(parseState(JSON.stringify({ version: 2 }))).toEqual(EMPTY_STATE);
    expect(parseState(JSON.stringify({ version: 1, lastRun: "x", skipped: "junk" })).skipped).toEqual([]);
  });

  test("a good run records itself as the last ok and clears the last error", () => {
    const failed = recordRun(EMPTY_STATE, { at: t0, ok: false, error: "boom", skipped: [] });
    expect(failed.lastError).toBe("boom");
    expect(failed.lastOk).toBeNull();
    const good = recordRun(failed, { at: at(60), ok: true, snapshot: "abc", skipped: [] });
    expect(good.lastOk).toBe(at(60).toISOString());
    expect(good.lastError).toBeNull();
    expect(good.lastSnapshot).toBe("abc");
  });

  test("an unchanged run keeps the previous snapshot; a failed run after a snapshot still records it", () => {
    const s1 = recordRun(EMPTY_STATE, { at: t0, ok: true, snapshot: "abc", skipped: [] });
    const s2 = recordRun(s1, { at: at(60), ok: true, snapshot: null, skipped: [] });
    expect(s2.lastSnapshot).toBe("abc");
    const s3 = recordRun(s2, { at: at(120), ok: false, error: "forget failed", snapshot: "def", skipped: [] });
    expect(s3.lastSnapshot).toBe("def");
    expect(s3.lastOk).toBe(at(60).toISOString());
  });

  test("a skipped root keeps the first time it was missed, and leaves the list when it is back", () => {
    const s1 = recordRun(EMPTY_STATE, { at: t0, ok: true, skipped: ["/mnt/x"] });
    const s2 = recordRun(s1, { at: at(60), ok: true, skipped: ["/mnt/x", "/mnt/y"] });
    expect(s2.skipped).toEqual([
      { root: "/mnt/x", since: t0.toISOString() },
      { root: "/mnt/y", since: at(60).toISOString() },
    ]);
    expect(recordRun(s2, { at: at(120), ok: true, skipped: [] }).skipped).toEqual([]);
  });

  test("the next run is due an hour after the last, or now when there was none", () => {
    expect(nextDue(EMPTY_STATE, t0)).toEqual(t0);
    const s = recordRun(EMPTY_STATE, { at: t0, ok: true, skipped: [] });
    expect(nextDue(s, at(10))).toEqual(at(60));
    expect(isOverdue(s, at(59))).toBe(false);
    expect(isOverdue(s, at(60))).toBe(true);
    // A failed run counts as a run: the retry waits for the next tick rather
    // than hammering a repository that is down.
    const failed = recordRun(EMPTY_STATE, { at: t0, ok: false, error: "x", skipped: [] });
    expect(isOverdue(failed, at(30))).toBe(false);
  });

  test("a machine with no snapshot of its own in the repository thins nothing", () => {
    // Its first backup is a backup of a machine that has not restored yet.
    expect(forgetDue(EMPTY_STATE)).toBe(false);
    expect(forgetDue(recordRun(EMPTY_STATE, { at: t0, ok: true, snapshot: "abc", skipped: [] }))).toBe(true);
    expect(forgetDue(recordRun(EMPTY_STATE, { at: t0, ok: false, error: "x", skipped: [] }))).toBe(false);
  });

  test("pruning is due once a day", () => {
    expect(pruneDue(EMPTY_STATE, t0)).toBe(true);
    const pruned = recordRun(EMPTY_STATE, { at: t0, ok: true, pruned: true, skipped: [] });
    expect(pruneDue(pruned, at(23 * 60))).toBe(false);
    expect(pruneDue(pruned, at(24 * 60))).toBe(true);
  });

  test("an idle exit backs up unless a good run is fresh", () => {
    expect(idleExitWorthIt(EMPTY_STATE, t0)).toBe(true);
    const s = recordRun(EMPTY_STATE, { at: t0, ok: true, skipped: [] });
    expect(idleExitWorthIt(s, at(5))).toBe(false);
    expect(idleExitWorthIt(s, at(10))).toBe(true);
  });
});

describe("restic command lines", () => {
  test("backup reads both lists, tags the snapshot, skips an unchanged tree, and speaks JSON", () => {
    expect(backupArgs({ filesFrom: "/t/in", excludeFile: "/t/ex" })).toEqual([
      "backup",
      "--files-from",
      "/t/in",
      "--exclude-file",
      "/t/ex",
      "--tag",
      "ledge",
      "--skip-if-unchanged",
      "--json",
    ]);
  });

  test("forget thins only Ledge's snapshots by the retention policy, pruning when asked", () => {
    const args = forgetArgs(false);
    expect(args.slice(0, 3)).toEqual(["forget", "--tag", "ledge"]);
    expect(args).toContain("--keep-hourly");
    expect(args[args.indexOf("--keep-monthly") + 1]).toBe(String(KEEP.monthly));
    expect(args).not.toContain("--prune");
    expect(forgetArgs(true)).toContain("--prune");
  });

  test("the policy keeps the newest snapshots whatever hour they fall in", () => {
    // The hourly rule keeps one snapshot per hour, so without this a backup
    // taken beside a recent one thins that one away.
    expect(forgetArgs(false)[forgetArgs(false).indexOf("--keep-last") + 1]).toBe(String(KEEP.last));
    expect(KEEP.last).toBeGreaterThan(1);
  });

  test("restore names the snapshot, the target and each include", () => {
    expect(restoreArgs({ snapshot: "latest", target: "/tmp/r", include: ["*/a.md", "*/b.md"] })).toEqual([
      "restore",
      "latest",
      "--target",
      "/tmp/r",
      "--include",
      "*/a.md",
      "--include",
      "*/b.md",
    ]);
  });

  test("the summary line yields the snapshot, and an empty or all-zero id means nothing changed", () => {
    const status = '{"message_type":"status","percent_done":1}';
    expect(parseBackupOutput(`${status}\n{"message_type":"summary","snapshot_id":"abc123"}\n`).snapshot).toBe("abc123");
    expect(parseBackupOutput(`${status}\n{"message_type":"summary"}\n`).snapshot).toBeNull();
    expect(parseBackupOutput(`{"message_type":"summary","snapshot_id":""}`).snapshot).toBeNull();
    expect(parseBackupOutput(`{"message_type":"summary","snapshot_id":"${"0".repeat(64)}"}`).snapshot).toBeNull();
    expect(parseBackupOutput("garbage\n").snapshot).toBeNull();
  });

  test("per-file errors are collected", () => {
    const out = parseBackupOutput('{"message_type":"error","error":{"message":"permission denied"},"item":"/x/y"}\n{"message_type":"summary","snapshot_id":"a"}');
    expect(out.errors).toEqual(["/x/y: permission denied"]);
    expect(out.snapshot).toBe("a");
  });

  test("a diff with no change lines means the snapshot is spurious; anything listed is a change", () => {
    expect(diffArgs("aaa", "bbb")).toEqual(["diff", "--json", "aaa", "bbb"]);
    expect(forgetOneArgs("bbb")).toEqual(["forget", "bbb", "--quiet"]);
    const stats = '{"message_type":"statistics","source_snapshot":"aaa","target_snapshot":"bbb","changed_files":0}';
    expect(parseDiffChanges(`${stats}\n`)).toBe(0);
    expect(parseDiffChanges(`{"message_type":"change","path":"/srv/ledge/Notes/a.md","modifier":"M"}\n{"message_type":"change","path":"/srv/ledge/Notes/b.md","modifier":"-"}\n${stats}\n`)).toBe(2);
    expect(parseDiffChanges("not json\n")).toBe(0);
  });

  test("snapshots --json reads into the fields status and restore use, and junk reads as none", () => {
    const list = parseSnapshots('[{"short_id":"a1","time":"2026-09-14T10:00:00Z","hostname":"vps","paths":["/srv/ledge"]},{"time":"x"}]');
    expect(list).toEqual([{ short_id: "a1", time: "2026-09-14T10:00:00Z", hostname: "vps", paths: ["/srv/ledge"] }]);
    expect(parseSnapshots("nope")).toEqual([]);
  });
});

describe("what status prints", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const restic = { path: "/usr/bin/restic", version: "0.19.1" };

  test("not set up says so on every line that needs it", () => {
    const lines = statusLines({ repository: null, restic: { missing: "restic is not installed" }, state: EMPTY_STATE, daemonUp: false, now });
    expect(lines[0]).toContain("run `ledge backup setup`");
    expect(lines[1]).toContain("restic is not installed");
    expect(lines[2]).toBe("last backup  never");
    expect(lines).toHaveLength(3);
  });

  test("a good run shows when, the snapshot, and when the next is due while the server is up", () => {
    const state = recordRun(EMPTY_STATE, { at: new Date("2026-09-14T11:30:00Z"), ok: true, snapshot: "abcdef0123", skipped: [] });
    const lines = statusLines({ repository: "s3:h/b", restic, state, daemonUp: true, now });
    expect(lines[2]).toBe("last backup  30 min ago, ok (snapshot abcdef01)");
    expect(lines[3]).toBe("next backup  in 30 min (the server is running)");
  });

  test("a failed run shows the failure and the last good one; a skipped root is shouted", () => {
    const good = recordRun(EMPTY_STATE, { at: new Date("2026-09-13T12:00:00Z"), ok: true, skipped: [] });
    const state = recordRun(good, { at: new Date("2026-09-14T11:00:00Z"), ok: false, error: "no route to host", skipped: ["/Volumes/Work"] });
    const lines = statusLines({ repository: "s3:h/b", restic, state, daemonUp: false, now });
    expect(lines[2]).toBe("last backup  1 h ago, FAILED: no route to host");
    expect(lines[3]).toBe("last good    24 h ago");
    expect(lines[4]).toBe("next backup  when the server next runs, and hourly while it does");
    expect(lines[5]).toBe("SKIPPED      /Volumes/Work (not on disk since 1 h ago)");
  });
});
