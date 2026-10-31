// The orphan sweep: a pool image no note names any more moves into the trash,
// and leaves the trash for good on the trash's own clock. server.ts runs it
// once per launch for each writable workspace, and again after an unlock for a
// workspace a locked note held back. architecture.md §3 has the rules this
// keeps: what counts as a reference, and why nothing is unlinked straight away.
import { basename, dirname, join, relative, resolve } from "node:path";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { assetsDirOf, imageMimeOf, trashedAssetsDirOf } from "./assets";
import { ensureTrashDir, readNote } from "./notes";
import { assertRegisteredRoot, assertWritableRoot, nameKey, rootContaining } from "./workspaces";

// How old a pool image must be before the sweep may trash it. A paste writes
// the image before the note naming it is saved, on this device or another.
export const ASSET_GRACE_MS = 24 * 60 * 60 * 1000;

export interface AssetSweep {
  /** Pool images moved into the trash. */
  trashed: number;
  /** Trashed images a note names again, moved back into the pool. */
  restored: number;
  /** A locked note's body could not be read, so nothing was trashed or purged. */
  held: boolean;
}

interface PoolFile {
  name: string;
  path: string;
  mtimeMs: number;
  ctimeMs: number;
}

// The image files directly in one pool directory. Dotted names are the
// in-flight temp files of a save (assets.ts writeAsset).
async function poolFiles(dir: string): Promise<PoolFile[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: PoolFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || imageMimeOf(entry.name) === null) continue;
    const path = join(dir, entry.name);
    const s = await stat(path).catch(() => null);
    if (s) out.push({ name: entry.name, path, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
  }
  return out;
}

// Every .md under the root. Wider than listNotes on purpose: a note in a
// dot-folder, in the trash or in a .ledgeignore'd folder can still show an
// image. Only .git is skipped, since no note a person edits lives in it.
async function everyNote(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== ".git") await walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(path);
    }
  };
  await walk(root);
  return out;
}

// Which of `names` appear anywhere in some note's text. The test is the file
// name as a substring, not a parsed reference, so no syntax (a title, angle
// brackets, an <img> tag, a reference-style link) hides an image from it. A
// false match keeps a file, which is the safe direction. `held` says a locked
// note's body was not readable, so the answer may be missing names.
async function namesInUse(root: string, names: readonly string[]): Promise<{ used: Set<string>; held: boolean }> {
  const forms = names.map((name) => ({ name, forms: [nameKey(name), nameKey(encodeURI(name.normalize("NFC")))] }));
  const used = new Set<string>();
  let held = false;
  for (const path of await everyNote(root)) {
    const file = await readNote(path).catch(() => null);
    if (file === null) continue;
    if (file.held) held = true;
    const text = nameKey(file.text);
    for (const f of forms) {
      if (!used.has(f.name) && f.forms.some((form) => text.includes(form))) used.add(f.name);
    }
    if (used.size === names.length) break;
  }
  return { used, held };
}

/**
 * Move every pool image no note names into the trash, and every trashed image
 * a note names again back into the pool. `now` is a parameter so tests can
 * stand past the grace period.
 *
 * A held answer (a locked note with the vault shut, or a damaged one) still
 * restores, since what it found named is named. It trashes nothing, since a
 * name it could not read may be the one that keeps an image.
 */
export async function sweepOrphanAssets(root: string, now = Date.now()): Promise<AssetSweep> {
  const r = assertWritableRoot(assertRegisteredRoot(root));
  const liveDir = assetsDirOf(r);
  const trashDir = trashedAssetsDirOf(r);
  const live = await poolFiles(liveDir);
  const trashed = await poolFiles(trashDir);
  const out: AssetSweep = { trashed: 0, restored: 0, held: false };
  if (live.length === 0 && trashed.length === 0) return out; // no pastes here: skip the walk

  const { used, held } = await namesInUse(r, [...live, ...trashed].map((f) => f.name));
  out.held = held;

  const liveKeys = new Set(live.map((f) => nameKey(f.name)));
  const trashedKeys = new Set(trashed.map((f) => nameKey(f.name)));
  for (const f of trashed) {
    if (!used.has(f.name) || liveKeys.has(nameKey(f.name))) continue;
    try {
      await mkdir(liveDir, { recursive: true });
      await rename(f.path, join(liveDir, f.name));
      liveKeys.add(nameKey(f.name));
      trashedKeys.delete(nameKey(f.name));
      out.restored += 1;
    } catch (err) {
      console.error("[assets] could not bring a trashed image back", f.path, err);
    }
  }
  if (held) return out;

  for (const f of live) {
    // A name the trashed pool already holds stays put: rename(2) would
    // clobber the trashed file. Pastes name against both pools, so only a file
    // copied in by hand gets here.
    if (used.has(f.name) || now - f.mtimeMs < ASSET_GRACE_MS || trashedKeys.has(nameKey(f.name))) continue;
    try {
      await ensureTrashDir(r, trashDir);
      await rename(f.path, join(trashDir, f.name));
      trashedKeys.add(nameKey(f.name));
      out.trashed += 1;
    } catch (err) {
      console.error("[assets] could not move an unused image to the trash", f.path, err);
    }
  }
  return out;
}

/**
 * The guard on the one asset unlink: an image file directly in its root's
 * trashed pool. Not a note, not the live pool, not a dotted temp file, not a
 * file in a folder below. Returns the root.
 */
export function assertTrashedAsset(path: string): string {
  const p = resolve(path);
  const root = rootContaining(p);
  if (!root || dirname(p) !== trashedAssetsDirOf(root) || basename(p).startsWith(".") || imageMimeOf(p) === null) {
    throw new Error(`not a trashed image: ${path}`);
  }
  return root;
}

/**
 * Unlink the trashed images that have waited out `ttlMs`, and return how many
 * went. The clock is ctime, for listTrash's reason (notes.ts): rename(2) sets
 * it as the image lands in the trash, and nothing touches it afterwards.
 */
export async function purgeTrashedAssets(root: string, ttlMs: number, now = Date.now()): Promise<number> {
  const r = assertWritableRoot(assertRegisteredRoot(root));
  let n = 0;
  for (const f of await poolFiles(trashedAssetsDirOf(r))) {
    if (now - f.ctimeMs < ttlMs) continue;
    try {
      assertTrashedAsset(f.path);
      await unlink(f.path);
      n += 1;
    } catch (err) {
      console.error("[assets] could not remove a trashed image", relative(r, f.path), err);
    }
  }
  return n;
}

/**
 * One workspace's launch-time pass: sweep, then purge. The sweep goes first so
 * a trashed image a note names again comes back before the purge could take
 * it. A held sweep skips the purge, for the reason it trashes nothing.
 */
export async function tidyAssets(root: string, ttlMs: number, now = Date.now()): Promise<AssetSweep & { purged: number }> {
  const sweep = await sweepOrphanAssets(root, now);
  const purged = sweep.held ? 0 : await purgeTrashedAssets(root, ttlMs, now);
  return { ...sweep, purged };
}
