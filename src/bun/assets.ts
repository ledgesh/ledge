// Local images for notes: the files behind `![](assets/x.png)` references.
// Bun owns them the way it owns notes — the webview never touches a path, it
// sends the markdown-relative reference and gets bytes back (assetRead), or
// asks for the pasteboard image to be saved and gets a reference back
// (assetPaste). Pasted images land in <root>/assets: visible, not dotted,
// because the notes root is the folder people sync and grep, and an image a
// note depends on should not be hidden from its owner.
//
// Nothing here ever unlinks an asset. Deleting a note leaves its images
// behind, deliberately: notes.ts's unlink policy (architecture.md §3) is
// scoped to exactly three trash paths, and orphaned images are a cheap price
// for never joining that list. The one unlink below is the temp-file discard
// on a failed save — the same sanctioned pattern as writeNote's.
import { join, resolve, extname, sep } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isInside, NOTES_ROOT, uniqueName } from "./notes";

export const ASSETS_DIR = join(NOTES_ROOT, "assets");

// The renderable set, by extension. An allowlist rather than "whatever has a
// dot": assetRead takes a view-supplied relative path, and the extension check
// is what keeps it from reading settings.json or a note — same load-bearing
// move as assertNote's `.md` requirement, inverted.
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
 * Resolve a markdown-relative image reference (`assets/x.png`) to an absolute
 * path, or throw. The guard for the one RPC that reads arbitrary view-supplied
 * relative paths: inside the root, an image extension from the allowlist, and
 * no dot-entries anywhere in it — dot-entries are the app's invisible files
 * (.trash, temp saves), and what listNotes hides, assetRead must not serve.
 */
export function assetPathOf(src: string): string {
  if (!src || src.startsWith("/") || src.includes("\\")) {
    throw new Error(`not an asset reference: ${src}`);
  }
  const path = resolve(NOTES_ROOT, src);
  if (!isInside(NOTES_ROOT, path)) throw new Error(`asset outside the notes root: ${src}`);
  // The root itself may be dotted (~/.ledge); only the parts under it count.
  const rel = path.slice(resolve(NOTES_ROOT).length + 1);
  if (rel.split(sep).some((part) => part.startsWith("."))) {
    throw new Error(`asset path names a dot-entry: ${src}`);
  }
  if (!imageMimeOf(path)) throw new Error(`not an image: ${src}`);
  return path;
}

/** The bytes behind an image reference, or null when the file is missing. */
export async function readAsset(src: string): Promise<{ dataB64: string; mime: string } | null> {
  const path = assetPathOf(src);
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
async function writeAsset(path: string, bytes: Uint8Array): Promise<void> {
  tmpCounter += 1;
  const tmp = join(ASSETS_DIR, `.asset.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Save pasted image bytes under assets/ and return the markdown-relative
 * reference to embed. The name is Bun's choice (the view never names a file):
 * dated for humans scanning the folder, allocated through uniqueName against a
 * readdir snapshot so the rename that follows cannot clobber (the same
 * clobber-safety story as note names, architecture.md §3).
 */
export async function savePastedImage(bytes: Uint8Array, ext = ".png"): Promise<string> {
  await mkdir(ASSETS_DIR, { recursive: true });
  const taken = new Set(await readdir(ASSETS_DIR));
  const base = `pasted-${new Date().toISOString().slice(0, 10)}`;
  const name = uniqueName(base, taken, ext);
  await writeAsset(join(ASSETS_DIR, name), bytes);
  // Forward slash always: this string goes into markdown, not a syscall.
  return `assets/${name}`;
}

// Read the pasteboard's image as PNG bytes, or null when it holds none.
// pbpaste is text-only, so this goes through osascript: AppKit promises a PNG
// rendition of whatever image flavor is on the pasteboard (a screenshot IS
// PNG; a browser-copied image is TIFF and converts), and «class PNGf» asks
// for exactly that. The AppleScript writes to a Bun-chosen temp file rather
// than printing hex to stdout — same bytes, none of the doubling and parsing.
export async function pasteboardImage(): Promise<Uint8Array | null> {
  await mkdir(ASSETS_DIR, { recursive: true });
  tmpCounter += 1;
  const tmp = join(ASSETS_DIR, `.paste.tmp-${process.pid}-${tmpCounter}`);
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

/** The whole paste flow: pasteboard → assets/, or null when there is no image. */
export async function pasteImageAsset(): Promise<string | null> {
  const bytes = await pasteboardImage();
  if (!bytes || bytes.length === 0) return null;
  return savePastedImage(bytes);
}
