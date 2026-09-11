// The view end of the image-asset RPCs (assetRead, assetPaste, assetPick).
// A configureX seam like lib/clipboard.ts: boot.tsx binds the live RPC and
// the harness binds an in-memory fake, so editor/images.ts is testable
// without either.

// Every call carries the workspace folder of the asking note and the note's
// own path. Both are opaque handles Bun issued, and Bun re-checks them on the
// way back in: assertRegisteredRoot for the folder, baseDirOf for the note
// (bun/assets.ts). Call sites read the two off the editor's docId
// (notes/store.ts folderOf, pathOf).

// Bun resolves a reference like `.ledge-assets/x.png` against the note that
// carries it (bun/assets.ts baseDirOf), so the same string in two folders
// names two files. Every answer is bounded by the folder that was passed in,
// so the same string in two workspaces names two files as well.

// With nothing configured, assetDataUrl, pasteImageAsset and pickImageAsset
// all resolve to null rather than throwing. A null read draws the
// broken-image placeholder (editor/images.ts broken()). assetDataUrl caches
// that null, so a reference read before boot.tsx binds stays null until the
// cache is cleared.

// What a read resolves to: bytes, `sealed`, or null (missing or broken).
// `sealed` means the file is a sealed image and the vault is locked, so the
// widget shows the locked placeholder (locking.md §5).
export type AssetReadResult = { dataB64: string; mime: string } | { sealed: true } | null;

type ProduceAsset = (folder: string, notePath: string | null) => Promise<string | null>;
// A paste may bring its own bytes, the picture a paste event carried
// (editor/clipboard.ts pasteEvent). Without them the client reads its pasteboard.
type PasteAsset = (folder: string, notePath: string | null, dataB64?: string) => Promise<string | null>;

let readHandler: ((folder: string, src: string, notePath: string | null) => Promise<AssetReadResult>) | null = null;
let pasteHandler: PasteAsset | null = null;
let pickHandler: ProduceAsset | null = null;

export function configureAssets(fns: {
  read: (folder: string, src: string, notePath: string | null) => Promise<AssetReadResult>;
  pasteImage: PasteAsset;
  pickImage: ProduceAsset;
}): void {
  readHandler = fns.read;
  pasteHandler = fns.pasteImage;
  pickHandler = fns.pickImage;
}

// Resolved data: URLs keyed by folder, note path, and markdown reference, so
// a widget redraw (the decoration set rebuilds on every selection move) does
// not re-issue the RPC. A folder-only key would serve one note the other's
// picture. No path or markdown reference carries a NUL, so the \0 join cannot
// collide with a real key. A null entry caches "missing" until the cache is
// cleared, by evictAssetCache or by the size cap below. livePreview bounds
// its link marks the same crude way.
const cache = new Map<string, string | "sealed" | null>();

/** Drop every cached data URL. A vault relock calls this from editorPool.ts's
 * onVaultChanged, beside evicting the open locked editors: the cache holds
 * decrypted image bytes, RAM the lock has to clear along with the note text
 * (locking.md §5). */
export function evictAssetCache(): void {
  cache.clear();
}

/** The data: URL for a note-relative image reference. Returns "sealed" for a
 * sealed image the vault must open first, and null when the file is missing
 * or unreadable. A "sealed" answer is cached like any other, so it survives
 * until the cache is cleared. A relock that evicted a locked editor clears it
 * (editorPool.ts onVaultChanged); an unlock does not. */
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
 * Save the pasteboard's image as an asset of the given workspace. Resolves to
 * the markdown-relative reference to embed, or null when the pasteboard holds
 * no image. `notePath` is the pasting note's file, null before its first save.
 * `dataB64` is the picture when the paste event already carried it. Bun seals
 * the bytes before writing them when that note is locked (locking.md §5).
 */
export function pasteImageAsset(folder: string, notePath: string | null = null, dataB64?: string): Promise<string | null> {
  return pasteHandler ? pasteHandler(folder, notePath, dataB64) : Promise.resolve(null);
}

/**
 * The same as pasteImageAsset, taking the bytes from the device's picture
 * picker: the macOS file dialog, or the iOS photo library (ios.md §11). The
 * Insert Image… command calls this. Resolves to null when the picker is
 * cancelled, which is the common outcome and not a failure.
 */
export function pickImageAsset(folder: string, notePath: string | null = null): Promise<string | null> {
  return pickHandler ? pickHandler(folder, notePath) : Promise.resolve(null);
}
