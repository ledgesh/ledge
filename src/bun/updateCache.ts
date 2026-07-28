// Housekeeping for Electrobun's self-extraction folder. The self-extracting
// wrapper in the DMG unpacks the real app out of a `<hash>.tar` and leaves
// that tar behind — 80MB per build, in
// `~/Library/Application Support/<identifier>/<channel>/self-extraction/`.
// Nothing ever removes it, so every version a user installs costs another
// copy forever.
//
// The tar is NOT garbage, which is why this prunes rather than empties: the
// updater bsdiffs from the CURRENT version's tar to the next one, and a
// missing baseline downgrades a patch into a full-bundle download
// (`local-tar-missing` in electrobun's Updater). So the live hash's tar
// stays and everything else goes — the previous versions' tars, which can
// never be a baseline again, and the `.patch` and `from-<hash>.tar` scratch
// files a patch run writes on its way through.
//
// This unlinks, which in this repo is a thing to justify (architecture.md
// §3). It is not in the notes tree: these are files Electrobun wrote into
// Application Support, named by content hash, that no listing shows and no
// user chose. The note rule — rename into `.ledge-trash`, never unlink — is
// about documents someone could want back. A stale tar is a cache.
//
// Nothing here imports `electrobun/bun`: that module boots the whole
// Electrobun runtime on import, and a folder of tars is answerable without
// it. `index.ts` supplies the two facts only Electrobun knows — where it
// extracts, and which hash is running.
import { rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The folder Electrobun extracts into, under the channel's app data dir. */
export const EXTRACTION_DIRNAME = "self-extraction";

// --- pure core (unit-tested in updateCache.test.ts) --------------------------

/** Which entries of the self-extraction folder are safe to delete, given the
 * hash of the version currently running.
 *
 * A null `liveHash` deletes nothing. Not knowing which tar is the baseline is
 * exactly the case where guessing costs a user a full download, and the cost
 * of skipping a prune is disk we were already spending. */
export function staleExtractionFiles(entries: string[], liveHash: string | null): string[] {
  if (!liveHash) return [];
  const keep = `${liveHash}.tar`;
  return entries.filter((e) => e !== keep && (e.endsWith(".tar") || e.endsWith(".patch")));
}

// --- the files ---------------------------------------------------------------

/** Delete the stale entries of one self-extraction folder. Split from the
 * caller below so it can be tested, and live-probed, against a real folder:
 * importing `electrobun/bun` boots the whole Electrobun runtime, which a
 * filesystem test has no business doing. */
export async function pruneExtractionDir(dir: string, liveHash: string | null): Promise<string[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // no extraction folder: a dev build, or a first run
  }

  const removed: string[] = [];
  for (const name of staleExtractionFiles(entries, liveHash)) {
    // recursive for `from-<hash>.tar`'s Windows sibling (`temp-<hash>/`) and
    // for a directory that a half-finished extraction left named like a tar.
    try {
      await rm(join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Locked, or gone since the readdir. Either way the next launch retries.
    }
  }
  return removed;
}
