// What a backup of this machine's Ledge state has to contain, and what it must
// not. The `backup-paths` verb (serve.ts) is the only caller; everything that
// decides anything lives here as one pure function, so the rules are testable
// without a filesystem and without a server.
//
// This module exists because "back up /data" is wrong in two directions, and
// both were live bugs in the shipped image (remote.md §11):
//
//   - Profiles are OUTSIDE the app home on purpose (architecture.md §6a: the
//     app home is the folder people sync, and layout is what keeps credentials
//     out of a synced notes folder). A backup that takes only the app home
//     takes every note that says `profile: prod` and none of the values, which
//     restores as a machine whose blocks all spawn with a warning.
//   - External workspace roots can be anywhere. The registry is the only thing
//     that knows where, so the backup set is a QUESTION FOR THE SERVER rather
//     than a path a user can be told once.
//
// The include list therefore names the app home WHOLE and subtracts from it,
// rather than enumerating the files inside it. A file added to the app home
// next year is then backed up by default; the failure mode of the other order
// is a new piece of state nobody remembers to add, discovered at a restore.
import { join } from "node:path";
import { isInside } from "./workspaces";

export interface BackupSet {
  /** Absolute paths to back up. */
  include: string[];
  /** Absolute paths inside those that must not travel. */
  exclude: string[];
}

export interface BackupInput {
  appHome: string;
  profilesDir: string;
  /** The registry's AVAILABLE roots. An unmounted volume is the caller's to
   * report (serve.ts warns): naming a path that is not there fails the whole
   * restic run, and silently dropping it is how a workspace stops being backed
   * up without anybody noticing. */
  roots: readonly string[];
  /** Include the profiles dir. False is for a caller who backs its secrets up
   * somewhere else; the default is true because a backup that omits them is
   * the bug this module was written for. */
  secrets: boolean;
}

/**
 * The include and exclude sets for one machine.
 *
 * Managed workspaces are direct children of the app home and the docs root is
 * inside it too, so roots are filtered to the ones the app home does not
 * already cover. Both lists are deduplicated and stable-ordered, because the
 * output is a file two commands diff against each other.
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
 * The app-home entries a backup must skip, and why each one:
 *
 * | Entry | Why |
 * | --- | --- |
 * | `.server.sock` | A unix socket. Not a file, not restorable, and archivers disagree about what to do with one. |
 * | `.server.pid` | Names a process on the machine being backed up. It is wrong the moment it is restored anywhere. |
 * | `logs/` | Diagnostics for a run, rotated, and the largest thing in the app home. A restore wants notes, not last month's stderr. |
 * | `.ledge-docs/` | The built-in manual, synced out of the binary at every launch (bun/docs.ts) and pruned by name. Backing it up stores a copy of the app's own documentation and restoring it stores a stale one. |
 */
function excludesFor(appHome: string): string[] {
  return [".server.sock", ".server.pid", "logs", ".ledge-docs"].map((name) => join(appHome, name));
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
