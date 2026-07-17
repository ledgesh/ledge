// The view end of the image-asset RPCs (assetRead / assetPaste), a configureX
// seam like clipboard.ts: main.tsx binds it to the live RPC, the harness binds
// an in-memory fake, and editor/images.ts stays testable without either.
//
// Unconfigured it degrades rather than throws — a missing binding costs a
// broken-image placeholder, not a crashed decoration pass.

let readHandler: ((src: string) => Promise<{ dataB64: string; mime: string } | null>) | null = null;
let pasteHandler: (() => Promise<string | null>) | null = null;

export function configureAssets(fns: {
  read: (src: string) => Promise<{ dataB64: string; mime: string } | null>;
  pasteImage: () => Promise<string | null>;
}): void {
  readHandler = fns.read;
  pasteHandler = fns.pasteImage;
}

// Resolved data: URLs by markdown reference, so every redraw of a widget (the
// decoration set rebuilds on each selection move) does not re-ride the RPC.
// null caches "missing" — a file that appears later is picked up after the
// cache recycles. Bounded the same crude way as livePreview's link marks.
const cache = new Map<string, string | null>();

/** The data: URL for a note-relative image reference, or null when missing. */
export async function assetDataUrl(src: string): Promise<string | null> {
  if (cache.has(src)) return cache.get(src)!;
  if (cache.size > 100) cache.clear();
  const image = readHandler ? await readHandler(src).catch(() => null) : null;
  const url = image ? `data:${image.mime};base64,${image.dataB64}` : null;
  cache.set(src, url);
  return url;
}

/**
 * Save the pasteboard's image (if any) as a note asset; resolves to the
 * markdown-relative reference to embed, or null when there is no image.
 */
export function pasteImageAsset(): Promise<string | null> {
  return pasteHandler ? pasteHandler() : Promise.resolve(null);
}
