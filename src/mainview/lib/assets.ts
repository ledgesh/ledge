// The view end of the image-asset RPCs (assetRead / assetPaste), a configureX
// seam like clipboard.ts: main.tsx binds it to the live RPC, the harness binds
// an in-memory fake, and editor/images.ts stays testable without either.
//
// Every call carries the workspace folder the asking note lives in: an
// `.ledge-assets/x.png` reference is only meaningful relative to its own workspace,
// so the same string in two workspaces is two different files. The folder is
// an opaque root handle from Bun; the call sites read it off the editor's
// docId (notes/store.ts folderOf).
//
// Unconfigured it degrades rather than throws — a missing binding costs a
// broken-image placeholder, not a crashed decoration pass.

// What a read resolves to: bytes, `sealed` (the file is a sealed image and
// the vault is locked — the widget shows the locked placeholder,
// docs/locking.md §5), or null (missing/broken).
export type AssetReadResult = { dataB64: string; mime: string } | { sealed: true } | null;

let readHandler: ((folder: string, src: string) => Promise<AssetReadResult>) | null = null;
let pasteHandler: ((folder: string, notePath: string | null) => Promise<string | null>) | null = null;

export function configureAssets(fns: {
  read: (folder: string, src: string) => Promise<AssetReadResult>;
  pasteImage: (folder: string, notePath: string | null) => Promise<string | null>;
}): void {
  readHandler = fns.read;
  pasteHandler = fns.pasteImage;
}

// Resolved data: URLs by folder + markdown reference, so every redraw of a
// widget (the decoration set rebuilds on each selection move) does not re-ride
// the RPC. The \0 join cannot collide with a real key: folders are paths and
// srcs are markdown references, neither carries a NUL. null caches "missing" —
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
export async function assetDataUrl(folder: string, src: string): Promise<string | "sealed" | null> {
  const key = `${folder}\0${src}`;
  if (cache.has(key)) return cache.get(key)!;
  if (cache.size > 100) cache.clear();
  const image = readHandler ? await readHandler(folder, src).catch(() => null) : null;
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
