// Local images for notes: the files behind `![](.ledge-assets/x.png)`
// references — though assetRead serves ANY in-root relative image reference,
// so a note in an attached folder can show the folder's own `img/photo.png`.
// Bun owns them the way it owns notes — the webview never touches a path, it
// sends the markdown-relative reference plus the workspace root it belongs to
// (an opaque handle the view got from Bun) and gets bytes back (assetRead), or
// asks for the pasteboard image to be saved and gets a reference back
// (assetPaste). Pasted images land in <root>/.ledge-assets — per workspace
// root, so a note's relative reference resolves against its own folder and an
// external workspace carries its images with it. Dotted and app-prefixed,
// like the trash: a workspace can be someone's real project folder, and
// Ledge's writes must be unmistakably Ledge's — pastes must not mingle into
// a project's own `assets/`. The price (Finder hides it) was weighed: an
// image a note depends on is still greppable by name, and the note carries
// its path.
//
// Nothing here ever unlinks an asset. Deleting a note leaves its images
// behind, deliberately: notes.ts's unlink policy (architecture.md §3) is
// scoped to exactly three trash paths, and orphaned images are a cheap price
// for never joining that list. The one unlink below is the temp-file discard
// on a failed save — the same sanctioned pattern as writeNote's.
import { join, resolve, extname, sep } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { ASSETS_DIRNAME } from "../shared/rpc-schema";
import { assertRegisteredRoot, isInside, uniqueName } from "./workspaces";

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
 * Resolve a markdown-relative image reference (`.ledge-assets/x.png`, or any
 * image inside the workspace folder) against its workspace root, or throw.
 * The guard for the one RPC that reads arbitrary view-supplied relative
 * paths: a registered root, inside that root, an image extension from the
 * allowlist, and no dot-entries anywhere in it — dot-entries are the app's
 * invisible files (.ledge-trash, temp saves), and what listNotes hides,
 * assetRead must not serve. The single exception is the app's own assets dir
 * as the FIRST segment: it is dotted precisely so its writes stay out of the
 * user's way, not to hide them from notes. Deeper dots stay rejected, which
 * is what keeps the in-flight `.asset.tmp-*` files unservable.
 */
export function assetPathOf(root: string, src: string): string {
  const r = assertRegisteredRoot(root);
  if (!src || src.startsWith("/") || src.includes("\\")) {
    throw new Error(`not an asset reference: ${src}`);
  }
  const path = resolve(r, src);
  if (!isInside(r, path)) throw new Error(`asset outside the workspace root: ${src}`);
  // The root itself may be dotted; only the parts under it count.
  const parts = path.slice(r.length + 1).split(sep);
  if (parts.slice(parts[0] === ASSETS_DIRNAME ? 1 : 0).some((part) => part.startsWith("."))) {
    throw new Error(`asset path names a dot-entry: ${src}`);
  }
  if (!imageMimeOf(path)) throw new Error(`not an image: ${src}`);
  return path;
}

/** The bytes behind an image reference, or null when the file is missing. */
export async function readAsset(root: string, src: string): Promise<{ dataB64: string; mime: string } | null> {
  const path = assetPathOf(root, src);
  try {
    const bytes = await readFile(path);
    return { dataB64: bytes.toString("base64"), mime: imageMimeOf(path)! };
  } catch {
    return null; // deleted or unreadable: the widget shows a broken placeholder
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
 */
export async function savePastedImage(root: string, bytes: Uint8Array, ext = ".png"): Promise<string> {
  const assetsDir = assetsDirOf(assertRegisteredRoot(root));
  await mkdir(assetsDir, { recursive: true });
  const taken = new Set(await readdir(assetsDir));
  const base = `pasted-${new Date().toISOString().slice(0, 10)}`;
  const name = uniqueName(base, taken, ext);
  await writeAsset(assetsDir, join(assetsDir, name), bytes);
  // Forward slash always: this string goes into markdown, not a syscall.
  return `${ASSETS_DIRNAME}/${name}`;
}

// Read the pasteboard's image as PNG bytes, or null when it holds none.
// pbpaste is text-only, so this goes through osascript: AppKit promises a PNG
// rendition of whatever image flavor is on the pasteboard (a screenshot IS
// PNG; a browser-copied image is TIFF and converts), and «class PNGf» asks
// for exactly that. The AppleScript writes to a Bun-chosen temp file rather
// than printing hex to stdout — same bytes, none of the doubling and parsing.
export async function pasteboardImage(root: string): Promise<Uint8Array | null> {
  const assetsDir = assetsDirOf(assertRegisteredRoot(root));
  await mkdir(assetsDir, { recursive: true });
  tmpCounter += 1;
  const tmp = join(assetsDir, `.paste.tmp-${process.pid}-${tmpCounter}`);
  const script = [
    "try",
    "  set d to the clipboard as «class PNGf»",
    "on error",
    '  return "none"',
    "end try",
    `set f to open for access POSIX file ${JSON.stringify(tmp)} with write permission`,
    "write d to f",
    "close access f",
    'return "ok"',
  ].join("\n");
  try {
    const p = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    if (out !== "ok") return null;
    const bytes = await readFile(tmp);
    return new Uint8Array(bytes);
  } catch {
    return null; // no osascript (non-macOS), or the write failed: no image
  } finally {
    await unlink(tmp).catch(() => {}); // discard our own temp, like writeNote
  }
}

/** The whole paste flow: pasteboard → <root>/.ledge-assets, or null when there is no image. */
export async function pasteImageAsset(root: string): Promise<string | null> {
  const bytes = await pasteboardImage(root);
  if (!bytes || bytes.length === 0) return null;
  return savePastedImage(root, bytes);
}
