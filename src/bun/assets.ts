// Local images for notes: the files behind `![](.ledge-assets/x.png)`
// references — though assetRead serves ANY in-root relative image reference,
// so a note in an attached folder can show the folder's own `img/photo.png`.
// Bun owns them the way it owns notes — the webview never touches a path, it
// sends the markdown-relative reference plus the workspace root it belongs to
// (an opaque handle the view got from Bun) and gets bytes back (assetRead), or
// asks for the pasteboard image to be saved and gets a reference back
// (assetPaste).
//
// A reference resolves against the NOTE that carries it (baseDirOf), not
// against the root, so a note one folder down writes `../.ledge-assets/x.png`.
// Notes live in folders now, and every other tool that reads Markdown —
// GitHub, Obsidian, VS Code, pandoc — resolves an image against the file it is
// in; a root-relative string would render in Ledge and nowhere else. The root
// stays in every call because it is still what bounds the answer.
//
// Pasted images land in <root>/.ledge-assets whatever folder the note sits in:
// one pool per workspace root, so two notes can share an image, an external
// workspace carries its images with it, and the lock sweep has one place to
// look. Dotted and app-prefixed, like the trash: a workspace can be someone's
// real project folder, and Ledge's writes must be unmistakably Ledge's —
// pastes must not mingle into a project's own `assets/`. The price (Finder
// hides it) was weighed: an image a note depends on is still greppable by
// name, and the note carries its path.
//
// Nothing here ever unlinks an asset. Deleting a note leaves its images
// behind, deliberately: notes.ts's unlink policy (architecture.md §3) is
// scoped to exactly three trash paths, and orphaned images are a cheap price
// for never joining that list. The one unlink below is the temp-file discard
// on a failed save — the same sanctioned pattern as writeNote's.
import { dirname, join, relative, resolve, extname, sep } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { ASSETS_DIRNAME } from "../shared/rpc-schema";
import { assertRegisteredRoot, assertWritableRoot, isInside, uniqueName } from "./workspaces";
import { isSealedAsset, openAssetBytes, sealAssetBytes, vaultState } from "./vault";

export function assetsDirOf(root: string): string {
  return join(resolve(root), ASSETS_DIRNAME);
}

// The renderable set, by extension. An allowlist rather than "whatever has a
// dot": assetRead takes a view-supplied relative path, and the extension check
// is what keeps it from reading a note or any in-root config — same
// load-bearing move as assertNote's `.md` requirement, inverted.
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  // In an <img> (which is all the view ever puts a src into) SVG scripts do
  // not execute, so this is as inert as the bitmaps above.
  ".svg": "image/svg+xml",
};

/** The MIME type an image path renders as, or null when it is not an image. */
export function imageMimeOf(path: string): string | null {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? null;
}

/**
 * The directory a reference resolves against: the folder of the note carrying
 * it, or the root when the caller names no note (a reference with no home,
 * which only the root-level case gets right).
 *
 * `from` arrives from the view alongside `src`, so it is checked like `src`: a
 * `.md` inside this root. That check is not what makes the resolution safe —
 * every rule below runs on the RESOLVED path, so a base pointing somewhere
 * odd still cannot widen what is readable. It is here so a client bug reads
 * as one rather than as a silently wrong reference.
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
 * Resolve a markdown-relative image reference (`.ledge-assets/x.png`,
 * `../.ledge-assets/x.png` from a note in a subfolder, or any image inside the
 * workspace folder) against the note that carries it, or throw.
 * The guard for the one RPC that reads arbitrary view-supplied relative
 * paths: a registered root, inside that root, an image extension from the
 * allowlist, and no dot-entries anywhere in it — dot-entries are the app's
 * invisible files (.ledge-trash, temp saves), and what listNotes hides,
 * assetRead must not serve. The single exception is the app's own assets dir
 * as the FIRST segment: it is dotted precisely so its writes stay out of the
 * user's way, not to hide them from notes. Deeper dots stay rejected, which
 * is what keeps the in-flight `.asset.tmp-*` files unservable. The segments
 * counted are the RESOLVED path's, under the root — so the `..` steps a
 * subfolder's reference begins with are spent before anything is judged, and
 * `../.ledge-assets/x.png` is the same file, and the same verdict, as
 * `.ledge-assets/x.png` from the root.
 */
export function assetPathOf(root: string, src: string, from?: string | null): string {
  const r = assertRegisteredRoot(root);
  if (!src || src.startsWith("/") || src.includes("\\")) {
    throw new Error(`not an asset reference: ${src}`);
  }
  // Anything the VIEW would draw as a remote image is not an asset, and the
  // two ends have to agree about which is which (editor/images.ts imageSrcOf
  // makes the same two tests, in the same order). Without this, `resolve`
  // happily turns `https://e.com/x.png` into `<root>/https:/e.com/x.png` —
  // in-root, dot-free, an image extension, accepted. It read as harmless while
  // nothing did more than fail to find the file; it stopped being harmless
  // when moveNote started REWRITING every reference this function accepts.
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

/** What a read hands back: the bytes, or `sealed` — the file exists but is a
 * sealed image (locking.md §5) and the vault is locked, so the widget
 * shows the locked-image placeholder rather than a broken one. */
export type AssetRead = { dataB64: string; mime: string } | { sealed: true } | null;

/** The bytes behind an image reference, or null when the file is missing.
 * A SEALED asset (magic-detected, whatever its name) decrypts here when the
 * vault is open — the one decrypt seam, exactly where the RPC reads. */
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
    return null; // damaged: broken placeholder is the honest face
  }
}

// Atomic like writeNote: temp file in the same directory, then rename(2), so a
// crash mid-save leaves no half-written image a note already references. The
// dotted temp name keeps it invisible and unservable (assetPathOf rejects
// dot-entries) for its whole short life.
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
 * markdown-relative reference to embed. The name is Bun's choice (the view
 * never names a file): dated for humans scanning the folder, allocated through
 * uniqueName against a readdir snapshot so the rename that follows cannot
 * clobber (the same clobber-safety story as note names, architecture.md §3).
 *
 * The file always lands in the ROOT's .ledge-assets/, whatever folder the
 * pasting note sits in: one pool per workspace is what lets two notes share an
 * image and what the lock sweep's key wrapping already assumes (locking.md
 * §5). Only the reference bends to the note, and `from` is what bends it.
 */
export async function savePastedImage(root: string, bytes: Uint8Array, ext = ".png", seal = false, from?: string | null): Promise<string> {
  // The docs root takes no pastes: its editor is read-only, so the returned
  // reference could never be inserted anyway — refuse before writing a file
  // nothing would ever show (assertWritableRoot, the one read-only gate).
  const assetsDir = assetsDirOf(assertWritableRoot(assertRegisteredRoot(root)));
  await mkdir(assetsDir, { recursive: true });
  const taken = new Set(await readdir(assetsDir));
  const base = `pasted-${new Date().toISOString().slice(0, 10)}`;
  const name = uniqueName(base, taken, ext);
  // A paste into a LOCKED note is sealed from the first byte (locking.md
  // §5): the plaintext never exists at this path — the never-unlink orphaning
  // stays a storage quirk, not a leak. Same name shape either way; the magic
  // header, not the filename, is what marks it.
  await writeAsset(assetsDir, join(assetsDir, name), seal ? sealAssetBytes(bytes) : bytes);
  return assetRefFor(root, join(assetsDir, name), from);
}

/** Re-write one asset's bytes in place (temp+rename): the lock sweep's seal
 * and Remove Lock's unseal. The name never changes, so references hold. */
export async function replaceAssetBytes(path: string, bytes: Uint8Array): Promise<void> {
  await writeAsset(dirname(path), path, bytes);
}

/** The raw on-disk bytes of an asset (the sweep reads before sealing). Takes
 * the resolved path, like replaceAssetBytes beside it: the sweep resolved
 * every reference already, and re-resolving would ask which note's folder to
 * resolve against a second time. */
export async function rawAssetBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** The server's half of a paste: bytes in, reference out, or null when the
 * pasteboard held no image and the client sent none. `seal` when the pasting
 * note is locked, which the caller reads off the note itself and never off a
 * view flag (locking.md §5).
 *
 * The pasteboard half is the CLIENT's (bun/clipboard.ts, remote.md §10): a
 * server across a connection has no pasteboard, and this file has no business
 * spawning osascript to find one. What stayed here is everything that decides
 * the file. */
export async function writePastedImage(root: string, bytes: Uint8Array, seal = false, from?: string | null): Promise<string | null> {
  if (bytes.length === 0) return null;
  return savePastedImage(root, bytes, extensionFor(bytes), seal, from);
}

/**
 * `.jpg` for JPEG bytes, `.png` for everything else.
 *
 * The extension has to follow the BYTES, because the name is what `imageMimeOf`
 * reads back and a JPEG called `.png` is an image the browser has to sniff its
 * way into. It became load-bearing when the picker arrived (ios.md §11): a
 * pasteboard image is a screenshot and genuinely PNG, but a picture off a
 * camera roll is a photograph, and re-encoding one losslessly turns 3 MB into
 * 28 MB — measured, on the first photo ever inserted from a phone.
 *
 * Two magics and a default, not a format library: this decides a file
 * extension, and anything it does not recognise is written as the `.png` it was
 * always written as before.
 */
export function extensionFor(bytes: Uint8Array): string {
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return jpeg ? ".jpg" : ".png";
}
