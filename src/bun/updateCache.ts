// Housekeeping for Electrobun's self-extraction folder
// (`~/Library/Application Support/<identifier>/<channel>/self-extraction/`).
// The DMG's self-extracting wrapper unpacks the real app out of a `<hash>.tar`
// and leaves that 80MB tar behind. Nothing in Electrobun removes it, so
// without this prune every installed version would cost another copy. The
// unlink sits outside architecture.md §3's rename-not-unlink rule: these are
// files the app wrote, named by content hash, that no user chose and no
// listing shows.
import { rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The folder Electrobun extracts into, under the channel's app data dir. */
export const EXTRACTION_DIRNAME = "self-extraction";

// --- pure core (unit-tested in updateCache.test.ts) --------------------------

/** The entries of the self-extraction folder that are safe to delete, given
 * `liveHash`, the hash of the version currently running. The live tar stays
 * as the updater's bsdiff baseline (a missing one turns a patch into a
 * full-bundle download: `local-tar-missing` in electrobun's Updater). Older
 * versions' tars can never be a baseline again, so they go, along with the
 * `.patch` and `from-<hash>.tar` scratch files a patch run writes.
 *
 * A null `liveHash` deletes nothing. Deleting the wrong tar costs a user a
 * full download, and keeping them all only costs disk. */
export function staleExtractionFiles(entries: string[], liveHash: string | null): string[] {
  if (!liveHash) return [];
  const keep = `${liveHash}.tar`;
  return entries.filter((e) => e !== keep && (e.endsWith(".tar") || e.endsWith(".patch")));
}

// --- the files ---------------------------------------------------------------

/** Delete the stale entries of one self-extraction folder, and return the
 * names removed. `dir` and `liveHash` are arguments, so a test or a live
 * probe can run this against a real folder. Deriving them here would mean
 * importing `electrobun/bun`, which boots the whole Electrobun runtime.
 * `index.ts` derives them and passes them in. */
export async function pruneExtractionDir(dir: string, liveHash: string | null): Promise<string[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // no extraction folder: a dev build, or a first run
  }

  const removed: string[] = [];
  for (const name of staleExtractionFiles(entries, liveHash)) {
    // An entry can be a directory rather than a file: a half-finished
    // extraction leaves one named like a tar. `recursive` removes that too.
    try {
      await rm(join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Locked, or gone since the readdir. Either way the next launch retries.
    }
  }
  return removed;
}
