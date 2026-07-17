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

let readHandler: ((folder: string, src: string) => Promise<{ dataB64: string; mime: string } | null>) | null = null;
let pasteHandler: ((folder: string) => Promise<string | null>) | null = null;

export function configureAssets(fns: {
  read: (folder: string, src: string) => Promise<{ dataB64: string; mime: string } | null>;
  pasteImage: (folder: string) => Promise<string | null>;
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
const cache = new Map<string, string | null>();

/** The data: URL for a note-relative image reference, or null when missing. */
export async function assetDataUrl(folder: string, src: string): Promise<string | null> {
  const key = `${folder}\0${src}`;
  if (cache.has(key)) return cache.get(key)!;
  if (cache.size > 100) cache.clear();
  const image = readHandler ? await readHandler(folder, src).catch(() => null) : null;
  const url = image ? `data:${image.mime};base64,${image.dataB64}` : null;
  cache.set(key, url);
  return url;
}

/**
 * Save the pasteboard's image (if any) as an asset of the given workspace;
 * resolves to the markdown-relative reference to embed, or null when there is
 * no image.
 */
export function pasteImageAsset(folder: string): Promise<string | null> {
  return pasteHandler ? pasteHandler(folder) : Promise.resolve(null);
}
