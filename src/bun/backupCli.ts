// The `ledge backup` verbs (interactions.md §9, remote.md §11): setup, now,
// status, snapshots, restore, paths, and a restic passthrough. Results go to
// stdout and talk to stderr, as the notes CLI does. Prompts go to stderr too,
// so `--json` output stays clean. serve.ts routes `backup` here, and the
// older `backup-paths` spelling lands on `paths`.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ask } from "./ask";
import { BACKUP_PROFILE, backupProfileText, backupSet, restoreArgs, s3Repository, statusLines } from "./backup";
import {
  configured,
  findRestic,
  listSnapshots,
  PROFILE_PATH,
  readConfig,
  readState,
  resticEnv,
  resticSaid,
  rootsOnDisk,
  runBackup,
  runRestic,
} from "./backupRun";
import { daemonPid, PID_PATH } from "./daemon";
import { writeProfile } from "./profiles";
import { PROFILES_DIR } from "./spawnParams";
import { APP_HOME, loadWorkspaces } from "./workspaces";

const USAGE = `usage: ledge backup <verb>

  setup        make a bucket the backup of this machine (asks for the endpoint,
               bucket and key; --existing joins a repository that already has
               backups in it; --from-env reads RESTIC_REPOSITORY, RESTIC_PASSWORD
               and the AWS_* pair from the environment; --repository SPEC names
               a non-S3 restic repository; --replace starts over)
  now          take a backup and thin old snapshots (--no-secrets leaves the
               profiles out)
  status       when the last backup ran and how it went (--json)
  snapshots    the snapshots in the repository, newest first
  restore      put files back from a snapshot: restore [--snapshot ID]
               [--to DIR] [--in-place] [PATTERN...]; the default is the newest
               snapshot into a fresh folder under your home
  paths        the paths a backup of this machine covers (--exclude, --json,
               --no-secrets), for a backup tool of your own
  restic ...   run restic itself with the backup's repository and credentials

Backups run every hour while this machine's Ledge server is up, and once more
before it exits. The repository and its credentials are the "${BACKUP_PROFILE}" profile.`;

const out = (text: string): void => void process.stdout.write(`${text}\n`);
const say = (text: string): void => void process.stderr.write(`${text}\n`);

/** Run `ledge backup ...`; `argv` is shaped like process.argv. Returns the exit status. */
export async function backupCli(argv: readonly string[]): Promise<number> {
  const verb = argv[3] ?? "help";
  const rest = argv.slice(4);
  if (verb !== "restic" && (rest.includes("--help") || rest.includes("-h"))) {
    out(USAGE);
    return 0;
  }
  switch (verb) {
    case "help":
    case "--help":
    case "-h":
      out(USAGE);
      return 0;
    case "paths":
      return paths(rest);
    case "setup":
      return setup(rest);
    case "now":
      return now(rest);
    case "status":
      return status(rest);
    case "snapshots":
      return snapshots();
    case "restore":
      return restore(rest);
    case "restic":
      return passthrough(rest);
    default:
      say(`ledge backup: no verb "${verb}"\n${USAGE}`);
      return 2;
  }
}

// --- paths -------------------------------------------------------------------

/**
 * Print the paths a backup of this machine has to cover (backup.ts), for a
 * tool of the user's own. Only the server can answer it: external workspace
 * roots are wherever the user attached them, and the registry is the only
 * thing that knows. A registered root that is not on disk goes to stderr and
 * stays out of stdout: naming it fails the whole run, and dropping it
 * silently is how a workspace leaves the backup set unnoticed.
 */
async function paths(args: readonly string[]): Promise<number> {
  await loadWorkspaces();
  const { present, skipped: missing } = rootsOnDisk();
  for (const r of missing) say(`[backup] skipping ${r}: not on disk (unmounted volume?)`);
  const secrets = !args.includes("--no-secrets");
  const set = backupSet({ appHome: APP_HOME, profilesDir: PROFILES_DIR, roots: present, secrets });
  if (args.includes("--json")) {
    out(JSON.stringify({ ...set, skipped: missing }, null, 2));
    return 0;
  }
  const lines = args.includes("--exclude") ? set.exclude : set.include;
  if (lines.length > 0) out(lines.join("\n"));
  return 0;
}

// --- setup -------------------------------------------------------------------

async function setup(args: readonly string[]): Promise<number> {
  const existing = args.includes("--existing");
  const fromEnv = args.includes("--from-env");
  const replace = args.includes("--replace");
  const repoFlag = valueOf(args, "--repository");
  if (!fromEnv && !process.stdin.isTTY) {
    say("ledge backup setup asks questions, and stdin is not a terminal. Pass --from-env with the variables set instead.");
    return 2;
  }
  const already = configured();
  if (already && !replace) {
    say(`Backups are already set up here, to ${already.repository}. \`ledge backup status\` shows how they are going; \`ledge backup setup --replace\` starts over.`);
    return 1;
  }

  const restic = await findRestic({ fetch: true, log: say });
  if ("missing" in restic) {
    say(restic.missing);
    return 1;
  }
  say(`Using restic ${restic.version}.`);

  // The variables, from the environment or from questions.
  const vars: Record<string, string> = {};
  let generated: string | null = null;
  if (fromEnv) {
    for (const k of ["RESTIC_REPOSITORY", "RESTIC_PASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      const v = process.env[k];
      if (v) vars[k] = v;
    }
    if (repoFlag) vars["RESTIC_REPOSITORY"] = repoFlag;
    if (!vars["RESTIC_REPOSITORY"]) return usage("--from-env needs RESTIC_REPOSITORY in the environment");
    if (!vars["RESTIC_PASSWORD"]) {
      if (existing) return usage("--existing needs RESTIC_PASSWORD in the environment");
      generated = newPassword();
      vars["RESTIC_PASSWORD"] = generated;
    }
  } else {
    say("");
    if (repoFlag) vars["RESTIC_REPOSITORY"] = repoFlag;
    else {
      say("The bucket. Any S3-compatible service works: S3, R2, B2, Wasabi, MinIO.");
      const endpoint = await ask("Endpoint (for example s3.amazonaws.com, or https://ACCOUNT.r2.cloudflarestorage.com)");
      const bucket = await ask("Bucket");
      if (!endpoint || !bucket) return usage("an endpoint and a bucket are both needed");
      vars["RESTIC_REPOSITORY"] = s3Repository(endpoint, bucket);
    }
    if (vars["RESTIC_REPOSITORY"].startsWith("s3:")) {
      vars["AWS_ACCESS_KEY_ID"] = await ask("Access key ID");
      vars["AWS_SECRET_ACCESS_KEY"] = await ask("Secret access key", { hidden: true });
      if (!vars["AWS_ACCESS_KEY_ID"] || !vars["AWS_SECRET_ACCESS_KEY"]) return usage("the key pair is needed for an S3 repository");
    }
    if (existing) {
      vars["RESTIC_PASSWORD"] = await ask("The repository's restic password", { hidden: true });
      if (!vars["RESTIC_PASSWORD"]) return usage("the password is needed to open an existing repository");
    } else {
      generated = newPassword();
      vars["RESTIC_PASSWORD"] = generated;
    }
  }

  await writeProfile(BACKUP_PROFILE, backupProfileText(vars));
  const read = readConfig();
  if (!("config" in read)) {
    say(`${PROFILE_PATH} is missing ${read.missing.join(", ")}`);
    return 1;
  }
  const env = resticEnv(read.config);

  // Open or create the repository. Either proves the address, the credentials
  // and (for --existing) the password before the first backup runs.
  if (existing) {
    say(`Opening ${read.config.repository}...`);
    const r = await runRestic(restic.path, ["cat", "config"], env);
    if (r.code !== 0) {
      say(`Could not open the repository: ${resticSaid(r)}\nThe profile is written at ${PROFILE_PATH}; fix it and run setup again with --replace.`);
      return 1;
    }
  } else {
    say(`Creating the repository at ${read.config.repository}...`);
    const r = await runRestic(restic.path, ["init"], env);
    if (r.code !== 0) {
      const said = resticSaid(r);
      const hint = /already (exists|initialized)/i.test(said)
        ? "\nThat repository already has backups in it. Run setup again with --existing and its password."
        : `\nThe profile is written at ${PROFILE_PATH}; fix it and run setup again with --replace.`;
      say(`Could not create the repository: ${said}${hint}`);
      return 1;
    }
  }

  say("Taking the first backup...");
  await loadWorkspaces();
  const result = await runBackup({ log: say, reason: "setup" });
  if (!result.ok) {
    say(result.error);
    return 1;
  }

  say("");
  say(`Backups are set up. They run every hour while this machine's Ledge server is up, and once more before it exits.`);
  say(`The repository and its credentials are in ${PROFILE_PATH}, the "${BACKUP_PROFILE}" profile.`);
  if (generated) {
    say("");
    say("This is the password that encrypts the backup. Keep a copy somewhere that is not this machine:");
    say("a restore starts on a machine with nothing on it, and a password stored only here is a backup you cannot open.");
    say("");
    out(generated);
  }
  return 0;
}

function newPassword(): string {
  return randomBytes(32).toString("base64url");
}

// --- now ---------------------------------------------------------------------

async function now(args: readonly string[]): Promise<number> {
  await loadWorkspaces();
  const result = await runBackup({ log: say, reason: "now", secrets: !args.includes("--no-secrets") });
  if (!result.ok) {
    say(result.error);
    return 1;
  }
  out(result.snapshot ? `snapshot ${result.snapshot.slice(0, 8)}` : "nothing changed since the last snapshot");
  return 0;
}

// --- status ------------------------------------------------------------------

async function status(args: readonly string[]): Promise<number> {
  const config = configured();
  const restic = await findRestic();
  const state = readState();
  const daemonUp = daemonRunning();
  if (args.includes("--json")) {
    out(JSON.stringify({ repository: config?.repository ?? null, restic, state, daemonUp }, null, 2));
    return 0;
  }
  out(statusLines({ repository: config?.repository ?? null, restic, state, daemonUp, now: new Date() }).join("\n"));
  return 0;
}

// --- snapshots ---------------------------------------------------------------

async function snapshots(): Promise<number> {
  const r = await listSnapshots();
  if ("error" in r) {
    say(r.error);
    return 1;
  }
  if (r.snapshots.length === 0) {
    say("no snapshots yet");
    return 1;
  }
  for (const s of r.snapshots) out(`${s.short_id}  ${s.time.replace(/\.\d+/, "").replace("T", " ")}  ${s.hostname}  ${s.paths.length} path${s.paths.length === 1 ? "" : "s"}`);
  return 0;
}

// --- restore -----------------------------------------------------------------

async function restore(args: readonly string[]): Promise<number> {
  const config = configured();
  if (!config) {
    say("backups are not set up on this machine: `ledge backup setup --existing` joins the repository they are in");
    return 1;
  }
  const restic = await findRestic();
  if ("missing" in restic) {
    say(restic.missing);
    return 1;
  }
  const snapshot = valueOf(args, "--snapshot") ?? "latest";
  const inPlace = args.includes("--in-place");
  const to = valueOf(args, "--to");
  if (inPlace && to) return usage("--in-place restores to the original paths; --to names another folder. One or the other.");
  const target = inPlace ? "/" : (to ?? join(homedir(), `ledge-restore-${stamp(new Date())}`));
  const include = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--snapshot" && args[i - 1] !== "--to");

  if (inPlace && daemonRunning()) {
    say(`This machine's Ledge server is running, and an in-place restore writes under it. Quit Ledge, or stop the daemon (kill $(cat ${PID_PATH})), and run this again.`);
    return 1;
  }
  say(`Restoring ${snapshot}${include.length > 0 ? ` (${include.join(", ")})` : ""} into ${target}...`);
  const r = await runRestic(restic.path, restoreArgs({ snapshot, target, include }), resticEnv(config));
  if (r.code !== 0) {
    say(`restic restore failed: ${resticSaid(r)}`);
    return 1;
  }
  const summary = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("Summary:"))
    .join(" ");
  if (summary) say(summary);
  out(target);
  return 0;
}

/** Whether this machine's daemon is up. The pid file alone can be a crash's
 * leftover (daemon.ts `daemonPid`), so the process is asked as well. */
function daemonRunning(): boolean {
  const pid = daemonPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// --- restic passthrough ------------------------------------------------------

async function passthrough(args: readonly string[]): Promise<number> {
  const config = configured();
  if (!config) {
    say("backups are not set up on this machine: run `ledge backup setup`");
    return 1;
  }
  const restic = await findRestic();
  if ("missing" in restic) {
    say(restic.missing);
    return 1;
  }
  const p = Bun.spawn([restic.path, ...args], { env: resticEnv(config), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await p.exited;
}

// --- prompts and arguments ---------------------------------------------------

function usage(message: string): number {
  say(`ledge backup: ${message}`);
  return 2;
}

function valueOf(args: readonly string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

