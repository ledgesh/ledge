// The Windows clipboard's HTML and pictures, for the editor's paste on Windows
// (bun/clientSeams.ts). Electrobun reads neither usefully there: it has no HTML
// read, and its image read returns the clipboard's CF_DIB bitmap rather than
// a PNG. So both are read through user32. The "HTML Format" entry is UTF-8
// with a header of byte offsets in front of the document (`cfHtmlFragment`).
// A picture is the "PNG" entry a browser or the Snipping Tool puts up beside
// the bitmap, and failing that the bitmap turned into a PNG (`dibToPng`).
import { deflateSync } from "node:zlib";
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";

const CF_DIB = 8;

/**
 * The copied part of a CF_HTML entry: the bytes between its StartFragment and
 * EndFragment offsets, as UTF-8. Where those offsets do not fit the bytes,
 * the text between the `<!--StartFragment-->` and `<!--EndFragment-->`
 * comments, and failing those, the whole entry after its header.
 */
export function cfHtmlFragment(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nul = buf.indexOf(0);
  const data = nul < 0 ? buf : buf.subarray(0, nul);
  const head = data.subarray(0, 512).toString("latin1");
  const offset = (name: string) => {
    const m = new RegExp(`^${name}:\\s*(\\d+)`, "m").exec(head);
    return m ? Number(m[1]) : -1;
  };
  const start = offset("StartFragment");
  const end = offset("EndFragment");
  if (start >= 0 && end > start && end <= data.length) return data.subarray(start, end).toString("utf8");
  const text = data.toString("utf8");
  const open = text.indexOf("<!--StartFragment-->");
  const close = text.indexOf("<!--EndFragment-->");
  if (open >= 0 && close > open) return text.slice(open + "<!--StartFragment-->".length, close);
  const doc = text.search(/<(!doctype|html)/i);
  return doc >= 0 ? text.slice(doc) : "";
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
  return out;
}

/** An 8-bit RGBA PNG of `rgba`, `width` × `height` pixels, rows top first. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 6; // RGBA
  // Every row with filter type 0, None.
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", new Uint8Array(0))]);
}

const BI_RGB = 0;
const BI_BITFIELDS = 3;

/**
 * A CF_DIB bitmap as a PNG, or null for one this does not read: fewer than 24
 * bits a pixel, or compressed. The pixels are BGR or BGRA rows padded to four
 * bytes, bottom row first unless the height is negative. A 32-bit bitmap with
 * every alpha byte 0 is an opaque one that left the byte unused.
 */
export function dibToPng(dib: Uint8Array): Buffer | null {
  if (dib.length < 40) return null;
  const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const headerSize = view.getUint32(0, true);
  const width = view.getInt32(4, true);
  const rawHeight = view.getInt32(8, true);
  const bits = view.getUint16(14, true);
  const compression = view.getUint32(16, true);
  const colorsUsed = view.getUint32(32, true);
  if (width <= 0 || rawHeight === 0 || (bits !== 24 && bits !== 32)) return null;
  if (compression !== BI_RGB && compression !== BI_BITFIELDS) return null;
  // A 40-byte header keeps BI_BITFIELDS' three masks after it. The larger
  // headers hold them inside.
  const masks = compression === BI_BITFIELDS && headerSize === 40 ? 12 : 0;
  const start = headerSize + masks + colorsUsed * 4;
  const height = Math.abs(rawHeight);
  const stride = Math.ceil((width * bits) / 32) * 4;
  if (start + stride * height > dib.length) return null;
  const step = bits / 8;
  const rgba = new Uint8Array(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const src = start + (rawHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const i = src + x * step;
      const o = (y * width + x) * 4;
      rgba[o] = dib[i + 2]!;
      rgba[o + 1] = dib[i + 1]!;
      rgba[o + 2] = dib[i]!;
      rgba[o + 3] = step === 4 ? dib[i + 3]! : 255;
      if (step === 4 && dib[i + 3] !== 0) anyAlpha = true;
    }
  }
  if (step === 4 && !anyAlpha) for (let o = 3; o < rgba.length; o += 4) rgba[o] = 255;
  return encodePng(width, height, rgba);
}

let win: ReturnType<typeof openWin> | null = null;

// Opened on first use: this module is imported on every platform.
function openWin() {
  const user32 = dlopen("user32.dll", {
    OpenClipboard: { args: [FFIType.ptr], returns: FFIType.i32 },
    CloseClipboard: { args: [], returns: FFIType.i32 },
    RegisterClipboardFormatW: { args: [FFIType.ptr], returns: FFIType.u32 },
    IsClipboardFormatAvailable: { args: [FFIType.u32], returns: FFIType.i32 },
    GetClipboardData: { args: [FFIType.u32], returns: FFIType.ptr },
  }).symbols;
  const kernel32 = dlopen("kernel32.dll", {
    GlobalLock: { args: [FFIType.ptr], returns: FFIType.ptr },
    GlobalUnlock: { args: [FFIType.ptr], returns: FFIType.i32 },
    GlobalSize: { args: [FFIType.ptr], returns: FFIType.u64 },
  }).symbols;
  const named = (name: string) => user32.RegisterClipboardFormatW(ptr(Buffer.from(`${name}\0`, "utf16le")));
  return { user32, kernel32, html: named("HTML Format"), png: named("PNG") };
}

/** The bytes of clipboard entry `format`, or null when it holds none or
 * another program has the clipboard open. */
function readFormat(format: number): Uint8Array | null {
  win ??= openWin();
  const { user32, kernel32 } = win;
  if (!user32.IsClipboardFormatAvailable(format) || !user32.OpenClipboard(null)) return null;
  try {
    const handle = user32.GetClipboardData(format);
    if (!handle) return null;
    const data = kernel32.GlobalLock(handle);
    if (!data) return null;
    try {
      const size = Number(kernel32.GlobalSize(handle));
      return size > 0 ? new Uint8Array(toArrayBuffer(data as Pointer, 0, size).slice(0)) : null;
    } finally {
      kernel32.GlobalUnlock(handle);
    }
  } finally {
    user32.CloseClipboard();
  }
}

/** The clipboard's HTML, or "" when it holds none. */
export function readWindowsClipboardHtml(): string {
  win ??= openWin();
  const bytes = readFormat(win.html);
  return bytes ? cfHtmlFragment(bytes) : "";
}

/** The clipboard's picture as PNG bytes, or null when it holds none. */
export function readWindowsClipboardImage(): Uint8Array | null {
  win ??= openWin();
  const png = readFormat(win.png);
  if (png && PNG_SIGNATURE.equals(png.subarray(0, 8))) return png;
  const dib = readFormat(CF_DIB);
  return dib ? dibToPng(dib) : null;
}
