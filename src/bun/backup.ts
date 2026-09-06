// The paths a backup of this machine's Ledge state must cover, and the ones it
// must skip. `backup-paths` (serve.ts) is the only caller. Every rule lives in
// this file, in pure functions testable without a filesystem or a server. The
// backup set is a runtime question, not a path list a user can be handed once:
// remote.md §11 has the policy and the reasons.
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
  /** The registered roots that are on disk. A root on an unmounted volume is
   * left out, and reporting it is the caller's job (serve.ts warns). Naming a
   * path that is not there fails the whole restic run. Dropping it silently
   * takes a workspace out of the backup set until someone tries to restore
   * it. */
  roots: readonly string[];
  /** Whether to include the profiles dir. `backup-paths` passes true unless
   * `--no-secrets` is given. False is for a caller that backs its secrets up
   * elsewhere. Profiles sit outside the app home to keep credentials out of
   * the folder people sync (architecture.md §6a). A backup without them
   * restores notes that name a profile but not the values. Those blocks then
   * spawn with a warning (spawnParams.ts). */
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
 */
function excludesFor(appHome: string): string[] {
  return [".server.sock", ".server.pid", "logs", ".ledge-docs"].map((name) => join(appHome, name));
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
