// The view end of the image-asset RPCs (assetRead / assetPaste / assetPick), a configureX
// seam like clipboard.ts: main.tsx binds it to the live RPC, the harness binds
// an in-memory fake, and editor/images.ts stays testable without either.
//
// Every call carries the workspace folder the asking note lives in AND the
// note's own path: an `.ledge-assets/x.png` reference is only meaningful
// relative to its own workspace, so the same string in two workspaces is two
// different files — and, since notes live in folders, the same string in two
// FOLDERS is two different files too. Bun resolves the reference against the
// note (bun/assets.ts baseDirOf). Both are opaque handles from Bun; the call
// sites read them off the editor's docId (notes/store.ts folderOf, pathOf).
//
// Unconfigured it degrades rather than throws — a missing binding costs a
// broken-image placeholder, not a crashed decoration pass.

// What a read resolves to: bytes, `sealed` (the file is a sealed image and
// the vault is locked — the widget shows the locked placeholder,
// locking.md §5), or null (missing/broken).
export type AssetReadResult = { dataB64: string; mime: string } | { sealed: true } | null;

type ProduceAsset = (folder: string, notePath: string | null) => Promise<string | null>;

let readHandler: ((folder: string, src: string, notePath: string | null) => Promise<AssetReadResult>) | null = null;
let pasteHandler: ProduceAsset | null = null;
let pickHandler: ProduceAsset | null = null;

export function configureAssets(fns: {
  read: (folder: string, src: string, notePath: string | null) => Promise<AssetReadResult>;
  pasteImage: ProduceAsset;
  pickImage: ProduceAsset;
}): void {
  readHandler = fns.read;
  pasteHandler = fns.pasteImage;
  pickHandler = fns.pickImage;
}

// Resolved data: URLs by folder + note + markdown reference, so every redraw
// of a widget (the decoration set rebuilds on each selection move) does not
// re-ride the RPC. The note is in the key because it is in the resolution: the
// same reference from two folders names two files, and a folder-only key would
// serve one note the other's picture. The \0 join cannot collide with a real
// key: folders and notes are paths and srcs are markdown references, none
// carries a NUL. null caches "missing" —
// a file that appears later is picked up after the cache recycles. Bounded the
// same crude way as livePreview's link marks.
const cache = new Map<string, string | "sealed" | null>();

/** Drop every cached data URL. The vault relock calls this (editorPool's
 * eviction): the cache is RAM-only, but RAM the lock must also clear — a
 * decrypted image surviving relock would outlive the promise ⌘L makes. */
export function evictAssetCache(): void {
  cache.clear();
}

/** The data: URL for a note-relative image reference; "sealed" for a sealed
 * image the vault must open first; null when missing. Sealed answers are
 * cached too — the relock/unlock transitions evict the whole cache, so a
 * stale placeholder never outlives the state that justified it. */
export async function assetDataUrl(folder: string, src: string, notePath: string | null = null): Promise<string | "sealed" | null> {
  const key = `${folder}\0${notePath ?? ""}\0${src}`;
  if (cache.has(key)) return cache.get(key)!;
  if (cache.size > 100) cache.clear();
  const image = readHandler ? await readHandler(folder, src, notePath).catch(() => null) : null;
  const url = image === null ? null : "sealed" in image ? ("sealed" as const) : `data:${image.mime};base64,${image.dataB64}`;
  cache.set(key, url);
  return url;
}

/**
 * Save the pasteboard's image (if any) as an asset of the given workspace;
 * resolves to the markdown-relative reference to embed, or null when there is
 * no image. `notePath` is the pasting note's file (null before its first
 * save): Bun seals the paste at birth when that note is locked.
 */
export function pasteImageAsset(folder: string, notePath: string | null = null): Promise<string | null> {
  return pasteHandler ? pasteHandler(folder, notePath) : Promise.resolve(null);
}

/**
 * The same, from the device's picture PICKER rather than its pasteboard: the
 * macOS file dialog, and on iOS the photo library (ios.md §11). Insert Image…
 * calls this, and on a phone it is the only way an image gets into a note —
 * there is no ⌘V there, and nothing has been copied.
 *
 * Resolves to null on a cancel, which is the common outcome and not a failure.
 */
export function pickImageAsset(folder: string, notePath: string | null = null): Promise<string | null> {
  return pickHandler ? pickHandler(folder, notePath) : Promise.resolve(null);
}
