// Local images for notes: the files behind `![](.ledge-assets/x.png)`
// references. assetRead serves any in-root relative image reference, including
// an attached folder's own `img/photo.png`. The webview never touches a path.
// It sends the markdown-relative reference plus the workspace root, an opaque
// handle Bun issued and re-checks (assertRegisteredRoot), and gets bytes back
// (assetRead) or a saved pasteboard image's reference (assetPaste).
//
// A reference resolves against the note that carries it (baseDirOf), not
// against the root, so a note one folder down writes `../.ledge-assets/x.png`.
// Notes live in folders, and every other tool that reads Markdown (GitHub,
// Obsidian, VS Code, pandoc) resolves an image against the file it is in. A
// root-relative string would render in Ledge and nowhere else. The root stays
// in every call because it bounds the answer.
//
// Pasted images land in <root>/.ledge-assets whatever folder the note sits in.
// One pool per root lets two notes share an image, lets an external workspace
// carry its images with it, and gives the lock sweep one place to look. The
// directory is dotted and app-prefixed because a workspace can be someone's
// real project folder, and Ledge's writes must not mingle into a project's own
// `assets/` (architecture.md §3). Finder hides dotted folders, which is the
// cost: the image is still greppable by name, and the note carries its path.
//
// Nothing here unlinks an asset, so this file joins none of the three unlink
// paths in notes.ts (architecture.md §3). Deleting a note orphans its images,
// and that is the trade: an orphan costs disk, joining that list costs a guard
// and a confirmation. The one unlink below is the temp-file discard on a
// failed save, the same pattern as writeNote.
import { dirname, join, relative, resolve, extname, sep } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { ASSETS_DIRNAME } from "../shared/rpc-schema";
import { assertRegisteredRoot, assertWritableRoot, isInside, uniqueName } from "./workspaces";
import { isSealedAsset, openAssetBytes, sealAssetBytes, vaultState } from "./vault";

export function assetsDirOf(root: string): string {
  return join(resolve(root), ASSETS_DIRNAME);
}

// The renderable set, by extension. An allowlist, not "whatever has a dot":
// assetRead takes a view-supplied relative path, and the extension check is
// what stops it reading a note or any in-root config. It is assertNote
// (notes.ts) inverted: that guard requires `.md`, and this list holds no `.md`.
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  // SVG scripts do not execute inside an <img>, and an <img> src is all the
  // view ever puts one of these in, so this is as inert as the bitmaps above.
  ".svg": "image/svg+xml",
};

/** The MIME type an image path renders as, or null when it is not an image. */
export function imageMimeOf(path: string): string | null {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? null;
}

/**
 * The directory a reference resolves against: the folder of the note carrying
 * it, or the root when no note is named (right only for a note at the root).
 *
 * `from` arrives from the view alongside `src`, so it is checked like `src`: a
 * `.md` inside this root. That check is not what makes the resolution safe.
 * Every rule below runs on the resolved path, so an odd base cannot widen what
 * is readable. The check is here so a client bug reads as one rather than as a
 * silently wrong reference.
 */
function baseDirOf(root: string, from: string | null | undefined): string {
  if (!from) return root;
  const note = resolve(from);
  if (!isInside(root, note) || !/\.md$/i.test(note)) {
    throw new Error(`not a note in this workspace: ${from}`);
  }
  return dirname(note);
}

/**
 * The reference a note at `from` carries for the asset at `path`: what
 * savePastedImage hands back for insertion. Forward slashes always, because
 * this string goes into markdown and not into a syscall.
 */
export function assetRefFor(root: string, path: string, from?: string | null): string {
  return relative(baseDirOf(assertRegisteredRoot(root), from), path).split(sep).join("/");
}

/**
 * Resolve a markdown-relative image reference against the note that carries
 * it, or throw. It takes `.ledge-assets/x.png`, `../.ledge-assets/x.png` from
 * a note in a subfolder, or any image inside the workspace folder.
 *
 * This is the guard for the one RPC that reads arbitrary view-supplied
 * relative paths (architecture.md §3). It requires a registered root, a path
 * inside that root, an image extension from the allowlist, and no dot-entries.
 * Dot-entries are the app's invisible files (.ledge-trash, temp saves), and
 * what listNotes hides assetRead must not serve. `.ledge-assets` is the one
 * exception, and only as the first segment, so the `.asset.tmp-*` files
 * writeAsset leaves in flight stay unservable. Segments are counted on the
 * resolved path under the root, so a subfolder's leading `..` steps are spent
 * first and `../.ledge-assets/x.png` gets the same verdict as
 * `.ledge-assets/x.png` from the root.
 */
export function assetPathOf(root: string, src: string, from?: string | null): string {
  const r = assertRegisteredRoot(root);
  if (!src || src.startsWith("/") || src.includes("\\")) {
    throw new Error(`not an asset reference: ${src}`);
  }
  // Anything the view would draw as a remote image is not an asset, and both
  // ends have to agree which is which (editor/images.ts imageSrcOf makes the
  // same two tests, in the same order). Without this, `resolve` turns
  // `https://e.com/x.png` into `<root>/https:/e.com/x.png`: in-root, dot-free,
  // an image extension, accepted. Nothing worse than a missing file happened
  // until moveNote began rewriting every reference this function accepts
  // (rebaseAssetRefs).
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || /^www\./i.test(src)) {
    throw new Error(`not an asset reference: ${src} (that is a URL, not a file in the workspace)`);
  }
  const path = resolve(baseDirOf(r, from), src);
  if (!isInside(r, path)) throw new Error(`asset outside the workspace root: ${src}`);
  // The root itself may be dotted; only the parts under it count.
  const parts = path.slice(r.length + 1).split(sep);
  if (parts.slice(parts[0] === ASSETS_DIRNAME ? 1 : 0).some((part) => part.startsWith("."))) {
    throw new Error(`asset path names a dot-entry: ${src}`);
  }
  if (!imageMimeOf(path)) throw new Error(`not an image: ${src}`);
  return path;
}

/** What a read hands back: the bytes, or `sealed`. `sealed` means the file
 * exists but is a sealed image (locking.md §5) and the vault is locked, so the
 * widget shows the locked-image placeholder rather than a broken one. */
export type AssetRead = { dataB64: string; mime: string } | { sealed: true } | null;

/** The bytes behind an image reference, or null when the file is missing. A
 * sealed asset (detected by its magic header, whatever its name) decrypts here
 * when the vault is open. This is the one decrypt seam for display, sitting
 * exactly where the RPC reads (locking.md §5). Remove Lock's unseal sweep
 * (removeLockNote in notes.ts) also decrypts, to write plaintext back. */
export async function readAsset(root: string, src: string, from?: string | null): Promise<AssetRead> {
  const path = assetPathOf(root, src, from);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return null; // deleted or unreadable: the widget shows a broken placeholder
  }
  if (!isSealedAsset(bytes)) return { dataB64: bytes.toString("base64"), mime: imageMimeOf(path)! };
  if (vaultState() !== "unlocked") return { sealed: true };
  try {
    return { dataB64: openAssetBytes(bytes).toString("base64"), mime: imageMimeOf(path)! };
  } catch (err) {
    console.warn("[vault] cannot open sealed image", path, err);
    return null; // damaged: the widget shows a broken placeholder
  }
}

// Atomic like writeNote: temp file in the same directory, then rename(2), so a
// crash mid-save leaves no half-written image a note already references. The
// dotted temp name keeps the file out of listings and unservable while it
// exists (assetPathOf rejects dot-entries).
let tmpCounter = 0;
async function writeAsset(assetsDir: string, path: string, bytes: Uint8Array): Promise<void> {
  tmpCounter += 1;
  const tmp = join(assetsDir, `.asset.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Save pasted image bytes under the root's .ledge-assets/ and return the
 * markdown-relative reference to embed. Bun names the file, never the view.
 * The name is dated for humans scanning the folder. uniqueName allocates it
 * against a readdir snapshot, so the rename that follows cannot clobber (the
 * same clobber-safety as note names, architecture.md §3).
 *
 * The file lands in the root's .ledge-assets/ whatever folder the pasting note
 * sits in. One pool per workspace is what lets two notes share an image, and
 * what the lock sweep's master-key wrapping assumes (locking.md §5). Only the
 * reference bends to the note, and `from` is what bends it.
 */
export async function savePastedImage(root: string, bytes: Uint8Array, ext = ".png", seal = false, from?: string | null): Promise<string> {
  // The docs root takes no pastes. Its editor is read-only, so the returned
  // reference could never be inserted, and assertWritableRoot, the one
  // read-only gate, refuses before this writes a file nothing would show.
  const assetsDir = assetsDirOf(assertWritableRoot(assertRegisteredRoot(root)));
  await mkdir(assetsDir, { recursive: true });
  const taken = new Set(await readdir(assetsDir));
  const base = `pasted-${new Date().toISOString().slice(0, 10)}`;
  const name = uniqueName(base, taken, ext);
  // A paste into a locked note is sealed from the first byte (locking.md §5).
  // The plaintext never exists at this path, so the never-unlink orphaning
  // above cannot leak one. The name is the same either way: the magic header
  // marks a sealed asset, not the filename.
  await writeAsset(assetsDir, join(assetsDir, name), seal ? sealAssetBytes(bytes) : bytes);
  return assetRefFor(root, join(assetsDir, name), from);
}

/** Re-write one asset's bytes in place (temp+rename): the lock sweep's seal
 * and Remove Lock's unseal. The name never changes, so references hold. */
export async function replaceAssetBytes(path: string, bytes: Uint8Array): Promise<void> {
  await writeAsset(dirname(path), path, bytes);
}

/** The raw on-disk bytes of an asset, which the lock sweep reads before
 * sealing. Takes a resolved path, like replaceAssetBytes beside it: the sweep
 * has resolved every reference already, and re-resolving would have to pick a
 * note's folder to resolve against a second time. */
export async function rawAssetBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** The server's half of a paste: bytes in, reference out, or null when the
 * pasteboard held no image and the client sent none. `seal` says the pasting
 * note is locked, and the caller reads that off the note itself, never off a
 * view flag (locking.md §5).
 *
 * The pasteboard half belongs to the client (bun/clipboard.ts, remote.md §10).
 * A server across a connection has no pasteboard to read, so this file spawns
 * no osascript. What stays here is everything that decides the file. */
export async function writePastedImage(root: string, bytes: Uint8Array, seal = false, from?: string | null): Promise<string | null> {
  if (bytes.length === 0) return null;
  return savePastedImage(root, bytes, extensionFor(bytes), seal, from);
}

/**
 * `.jpg` for JPEG bytes, `.png` for everything else.
 *
 * The extension follows the bytes because the name is what `imageMimeOf` reads
 * back. A JPEG called `.png` is an image the browser has to sniff its way
 * into. It became load-bearing with the photo picker (ios.md §11): a
 * pasteboard image is a screenshot, and there the source really is PNG, but a
 * camera-roll picture is a photograph. Re-encoding the first photo ever
 * inserted from a phone losslessly turned 3 MB into 28 MB.
 *
 * One magic test and a default, not a format library. This decides a file
 * extension, and anything it does not recognise is written as `.png`, which is
 * what everything was written as before.
 */
export function extensionFor(bytes: Uint8Array): string {
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return jpeg ? ".jpg" : ".png";
}
