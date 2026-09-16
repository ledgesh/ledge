#!/usr/bin/env bun
// The backup against a real bucket (remote.md §11, testing.md §6): an S3
// server in Docker (versitygw: on Docker Hub, one process, no setup; MinIO's
// images left the Hub in 2025), the restic release fetched and checksummed by
// `setup` itself where no restic is on the PATH, then
// setup, now, status, snapshots, restore and the daemon's idle-exit backup,
// all against a scratch app home. Run it: `bun run probe:backup`. Docker has
// to be running.
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = await mkdtemp(join(tmpdir(), "ledge-backup-probe-"));
const HOME = join(SCRATCH, "home");
const PROFILES = join(SCRATCH, "profiles");
const EXTERNAL = join(SCRATCH, "attached");
// Before any Ledge module loads, per testing.md §6.
process.env["LEDGE_NOTES_ROOT"] = HOME;
process.env["LEDGE_PROFILES_DIR"] = PROFILES;

const { startDaemon } = await import("../src/bun/daemon");
const { backupScheduler, readState, STATE_PATH } = await import("../src/bun/backupRun");

const REPO = join(import.meta.dir, "..");
const SERVE = join(REPO, "src", "bun", "serve.ts");
const CONTAINER = "ledge-backup-probe";
const PORT = 9100;
const BUCKET = "ledge-probe";
const S3 = {
  RESTIC_REPOSITORY: `s3:http://127.0.0.1:${PORT}/${BUCKET}`,
  AWS_ACCESS_KEY_ID: "probe",
  AWS_SECRET_ACCESS_KEY: "probe-secret-key",
};

let failures = 0;
const ok = (claim: string, detail = "") => console.log(`  ok    ${claim}${detail && `  (${detail})`}`);
const bad = (claim: string, detail = "") => {
  failures++;
  console.log(`  FAIL  ${claim}${detail && `  (${detail})`}`);
};
const check = (claim: string, cond: boolean, detail = "") => (cond ? ok(claim, detail) : bad(claim, detail));
const step = (s: string) => console.log(`\n${s}`);

function run(cmd: string[], opts: { env?: Record<string, string>; quiet?: boolean } = {}) {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...opts.env } });
  const out = p.stdout.toString().trim();
  const err = p.stderr.toString().trim();
  if (p.exitCode !== 0 && !opts.quiet) throw new Error(`${cmd.slice(0, 4).join(" ")}… exited ${p.exitCode}\n${err || out}`);
  return { code: p.exitCode, out, err };
}

/** `ledge backup ...` from this checkout, against the scratch home. */
const ledge = (args: string[], env: Record<string, string> = {}) => run([process.execPath, SERVE, "backup", ...args], { env, quiet: true });

async function teardown() {
  run(["docker", "rm", "-f", CONTAINER], { quiet: true });
  await rm(SCRATCH, { recursive: true, force: true });
}

try {
  step("fixture: an S3 server in Docker, a scratch home with a managed and an attached workspace, a profile");
  run(["docker", "rm", "-f", CONTAINER], { quiet: true });
  run([
    "docker", "run", "-d", "--name", CONTAINER, "-p", `127.0.0.1:${PORT}:7070`, "--tmpfs", "/data",
    "-e", `ROOT_ACCESS_KEY=${S3.AWS_ACCESS_KEY_ID}`, "-e", `ROOT_SECRET_KEY=${S3.AWS_SECRET_ACCESS_KEY}`,
    "versity/versitygw:latest", "posix", "/data",
  ]);
  for (let i = 0; i < 60; i++) {
    // Any HTTP answer at all: an unsigned request is refused, which is enough.
    const up = await fetch(`http://127.0.0.1:${PORT}/`).then(() => true).catch(() => false);
    if (up) break;
    await Bun.sleep(500);
    if (i === 59) throw new Error("the S3 server did not come up");
  }
  const managed = join(HOME, "Notes");
  mkdirSync(managed, { recursive: true });
  mkdirSync(EXTERNAL, { recursive: true });
  mkdirSync(PROFILES, { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME, "logs"), { recursive: true });
  writeFileSync(join(HOME, ".workspaces.json"), JSON.stringify({ version: 1, roots: [managed, EXTERNAL] }));
  writeFileSync(join(managed, "probe-note.md"), "# Probe Note\n\nfirst version\n");
  writeFileSync(join(EXTERNAL, "attached-note.md"), "# Attached Note\n\nlives outside the app home\n");
  writeFileSync(join(PROFILES, "prod.env"), "SECRET_VALUE=hunter2\n", { mode: 0o600 });
  writeFileSync(join(HOME, "logs", "ledge-server.log"), "not backed up\n");
  ok("fixture up");

  step("setup --from-env: fetches restic when needed, writes the profile, creates the repository, takes the first backup");
  const setup = ledge(["setup", "--from-env"], S3);
  check("setup exited 0", setup.code === 0, setup.err.split("\n").slice(-3).join(" | "));
  const password = setup.out.trim();
  check("the generated password came out on stdout", /^[A-Za-z0-9_-]{40,}$/.test(password), `${password.length} chars`);
  const profilePath = join(PROFILES, "backup.env");
  check("the backup profile exists and is private", existsSync(profilePath) && (statSync(profilePath).mode & 0o777) === 0o600);
  const profile = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
  check("the profile holds the repository and the password", profile.includes(`RESTIC_REPOSITORY=${S3.RESTIC_REPOSITORY}`) && profile.includes(`RESTIC_PASSWORD=${password}`));
  check("restic came from the PATH or was fetched under .server", /Using restic \d+\.\d+\.\d+/.test(setup.err), /downloading restic/.test(setup.err) ? "fetched" : "on the PATH");
  let state = readState();
  check("the state file records a good first run with a snapshot", state.lastOk !== null && state.lastSnapshot !== null, STATE_PATH);

  step("setup again: refused without --replace");
  const again = ledge(["setup", "--from-env"], S3);
  check("a second setup is refused and says so", again.code === 1 && /already set up/.test(again.err));

  step("now: a changed note makes a snapshot; nothing changed makes none");
  writeFileSync(join(managed, "probe-note.md"), "# Probe Note\n\nsecond version\n");
  const now1 = ledge(["now"]);
  check("a change was snapshotted", now1.code === 0 && /^snapshot [0-9a-f]{8}$/.test(now1.out), now1.out || now1.err);
  const now2 = ledge(["now"]);
  check("an unchanged tree makes no snapshot", now2.code === 0 && now2.out === "nothing changed since the last snapshot", now2.out || now2.err);

  step("an attached workspace that is not on disk is skipped, said on stderr, and shown by status");
  renameSync(EXTERNAL, `${EXTERNAL}.unmounted`);
  const now3 = ledge(["now"]);
  check("the run still succeeds", now3.code === 0, now3.err.split("\n").slice(-1)[0]);
  check("the skip is said on stderr", now3.err.includes(`skipping ${EXTERNAL}`));
  const status1 = ledge(["status"]);
  check("status shows the skipped root", status1.code === 0 && status1.out.includes(`SKIPPED      ${EXTERNAL}`), status1.out.split("\n").find((l) => l.startsWith("SKIPPED")) ?? status1.out);
  renameSync(`${EXTERNAL}.unmounted`, EXTERNAL);
  ledge(["now"]);
  const status2 = ledge(["status"]);
  check("status clears it once the root is back", !status2.out.includes("SKIPPED"), status2.out.replace(/\n/g, " | "));
  check("status says the last backup was ok", /last backup  .*ok/.test(status2.out));

  step("paths and the older spelling");
  const paths = ledge(["paths"]);
  check("paths lists the app home, the attached root and the profiles", paths.out.split("\n").length === 3 && paths.out.includes(EXTERNAL) && paths.out.includes(PROFILES));
  const noSecrets = ledge(["paths", "--no-secrets"]);
  check("--no-secrets drops the profiles", !noSecrets.out.includes(PROFILES));
  const old = run([process.execPath, SERVE, "backup-paths", "--exclude"], { quiet: true });
  check("backup-paths --exclude still answers", old.code === 0 && old.out.includes(join(HOME, ".server")));

  step("snapshots and restore");
  const snaps = ledge(["snapshots"]);
  check("snapshots lists more than one", snaps.code === 0 && snaps.out.split("\n").length >= 2, `${snaps.out.split("\n").length} listed`);
  const restoreTo = join(SCRATCH, "restored");
  const restored = ledge(["restore", "--to", restoreTo, "*/probe-note.md"]);
  check("restore of one note exits 0 and prints the target", restored.code === 0 && restored.out === restoreTo, restored.err.split("\n").slice(-1)[0]);
  const back = join(restoreTo, managed, "probe-note.md");
  check("the restored note is the latest version", existsSync(back) && readFileSync(back, "utf8").includes("second version"), back);
  const restoredAll = ledge(["restore", "--to", join(SCRATCH, "restored-all")]);
  check("a whole restore brings the profile and the attached note, not the logs",
    restoredAll.code === 0 &&
      existsSync(join(SCRATCH, "restored-all", PROFILES, "prod.env")) &&
      existsSync(join(SCRATCH, "restored-all", EXTERNAL, "attached-note.md")) &&
      !existsSync(join(SCRATCH, "restored-all", HOME, "logs")));
  const restic = ledge(["restic", "check", "--no-lock"]);
  check("the restic passthrough runs check against the repository", restic.code === 0);

  step("two backups in the same hour both live through the thinning");
  writeFileSync(join(managed, "probe-note.md"), "# Probe Note\n\nburst one\n");
  const burst1 = ledge(["now"]);
  writeFileSync(join(managed, "probe-note.md"), "# Probe Note\n\nburst two\n");
  const burst2 = ledge(["now"]);
  const burstIds = ledge(["snapshots"]).out.split("\n").map((l) => l.split("  ")[0]);
  const idOf = (r: { out: string }) => r.out.replace("snapshot ", "").trim();
  check("the earlier one survives the later one's forget (KEEP.last, not the hourly bucket)",
    burst1.code === 0 && burst2.code === 0 && burstIds.includes(idOf(burst1)) && burstIds.includes(idOf(burst2)),
    `${idOf(burst1)}, ${idOf(burst2)} of ${burstIds.join(", ")}`);

  step("the daemon backs up before an idle exit");
  writeFileSync(join(managed, "probe-note.md"), "# Probe Note\n\nthird version\n");
  const before = readState().lastSnapshot;
  const { loadWorkspaces } = await import("../src/bun/workspaces");
  await loadWorkspaces();
  const log: string[] = [];
  const sched = backupScheduler({ log: (l) => log.push(l), idleGapMs: 0, startDelayMs: 60_000 });
  const d = await startDaemon({ idleMs: 500, beforeIdleExit: () => sched.beforeIdleExit() });
  sched.start();
  await Promise.race([d.done, Bun.sleep(60_000).then(() => { throw new Error("the daemon did not exit"); })]);
  sched.stop();
  state = readState();
  check("the idle exit took a snapshot first", state.lastSnapshot !== null && state.lastSnapshot !== before, log.find((l) => /snapshot/.test(l)) ?? log.join(" | "));
  const restoredThird = ledge(["restore", "--to", join(SCRATCH, "restored-3"), "*/probe-note.md"]);
  check("and it holds the newest text", restoredThird.code === 0 && readFileSync(join(SCRATCH, "restored-3", managed, "probe-note.md"), "utf8").includes("third version"));

  step("setup --existing --replace joins the repository with its password, and leaves it as it found it");
  const snapsBeforeJoin = ledge(["snapshots"]).out;
  const runBeforeJoin = readState().lastRun;
  const rejoin = ledge(["setup", "--from-env", "--existing", "--replace"], { ...S3, RESTIC_PASSWORD: password });
  check("rejoining succeeds", rejoin.code === 0, rejoin.err.split("\n").slice(-2).join(" | "));
  check("no new password is printed", rejoin.out === "");
  // What the disaster-recovery flow depends on: the machine joining has
  // nothing on it, so a backup of it here would thin what it came to restore.
  check("joining takes no backup: the snapshots are the ones that were already there",
    ledge(["snapshots"]).out === snapsBeforeJoin && readState().lastRun === runBeforeJoin,
    ledge(["snapshots"]).out.split("\n").length + " listed");
  check("and it names the newest snapshot and the restore to run",
    /newest snapshot is [0-9a-f]{8}/.test(rejoin.err) && /ledge backup restore --in-place/.test(rejoin.err),
    rejoin.err.split("\n").filter(Boolean).slice(-5).join(" | "));
  const wrong = ledge(["setup", "--from-env", "--existing", "--replace"], { ...S3, RESTIC_PASSWORD: "not-it" });
  check("the wrong password is refused", wrong.code === 1 && /Could not open/.test(wrong.err));
  const fresh = ledge(["setup", "--from-env", "--replace"], S3);
  check("a fresh setup on a used repository points at --existing", fresh.code === 1 && /--existing/.test(fresh.err), fresh.err.split("\n").slice(-1)[0]);
} catch (err) {
  bad("probe aborted", err instanceof Error ? err.message : String(err));
} finally {
  await teardown();
}

console.log(failures === 0 ? "\nbackup probe: all claims held" : `\nbackup probe: ${failures} claim(s) failed`);
process.exit(failures === 0 ? 0 : 1);
