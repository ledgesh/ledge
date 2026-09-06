// The system pasteboard. The webview runs under the views:// scheme, which is
// not a secure context. `navigator.clipboard` is unavailable there, so
// copy/paste goes through this process (rpc-schema.ts, clipboardRead).
//
// Text is `pbcopy`/`pbpaste`. The HTML flavor is not: `pbpaste` reads
// `public.utf8-plain-text`, `public.rtf` and PostScript and nothing else, and
// Electrobun's clipboard FFI reads text and images only. So the HTML flavor
// takes the same route `readClipboardImage` takes below, osascript.
// AppleScript can name a pasteboard type this process has no binding for.
//
// Reading `«class HTML»` costs a hex round trip. AppleScript prints raw data
// as `«data HTML3C68…»`, so the bytes come back doubled and are parsed here.
// HTML is text-shaped and small (a pasteboard flavor is a selection, not a
// file), so this path pays that cost instead of writing the temp file
// `readClipboardImage` uses for megabyte-sized PNGs.

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CLIENT_HOME, ensureClientHome } from "./clientHome";

const HTML_SCRIPT = [
  "try",
  "  set d to the clipboard as «class HTML»",
  "on error",
  '  return "none"',
  "end try",
  "return d",
].join("\n");

// AppleScript's raw-data literal. The character class takes whitespace instead
// of ending the hex run, in case a long payload arrives wrapped, and
// `htmlFromScriptOutput` strips it before decoding. The closing guillemet is
// required, so a run cut short reads as no HTML instead of as a truncated
// document.
const DATA = /data\s+HTML([0-9A-Fa-f\s]*)»/;

/**
 * The HTML bytes from an osascript run's stdout, or "" when the pasteboard
 * held no HTML (the script answers "none") and when the literal is malformed.
 * A flavor this cannot decode counts as no flavor, and the caller still has
 * the plain text.
 *
 * This decodes the bytes as UTF-8 unless a leading BOM says UTF-16. WebKit and
 * every Cocoa app write `public.html` as UTF-8, down to the opening
 * `<meta charset>`. A Windows-authored flavor arriving over a remote desktop
 * can be UTF-16, and decoding that as UTF-8 gives text interleaved with NULs,
 * which is worse than pasting nothing.
 */
export function htmlFromScriptOutput(out: string): string {
  const hex = DATA.exec(out)?.[1]?.replace(/\s+/g, "") ?? "";
  // An odd nibble count means the literal was not read the way it was written.
  if (hex.length < 2 || hex.length % 2 !== 0) return "";
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return "";
    bytes[i] = byte;
  }
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes).replace(/^\ufeff/, "");
  } catch {
    return "";
  }
}

export async function writeClipboard(text: string): Promise<void> {
  try {
    const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    p.stdin.write(text);
    await p.stdin.end();
    await p.exited;
  } catch {
    // No pbcopy (non-macOS or PATH issue); drop silently.
  }
}

export async function readClipboardText(): Promise<string> {
  try {
    const p = Bun.spawn(["pbpaste"], { stdout: "pipe" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    return text;
  } catch {
    return "";
  }
}

/** The pasteboard's `public.html`, or "" when it carries none. */
export async function readClipboardHtml(): Promise<string> {
  try {
    const p = Bun.spawn(["osascript", "-e", HTML_SCRIPT], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return htmlFromScriptOutput(out);
  } catch {
    return ""; // no osascript (non-macOS): plain text is the whole pasteboard
  }
}

// Read the pasteboard's image as PNG bytes, or null when it holds none.
// pbpaste is text-only, so this goes through osascript. «class PNGf» asks
// AppKit for a PNG rendition of whatever image flavor is there: a screenshot
// is already PNG, a browser-copied image is TIFF and converts. The script
// writes a temp file rather than printing hex, skipping the doubling above.
//
// The temp goes in the client home, not the workspace's assets folder. Across
// a connection the notes are on another machine, and this seam has to run on
// the machine holding the pasteboard (remote.md §10). A paste into a locked
// note puts plaintext in that temp, and the unlink below is immediate.
// locking.md §5 documents the caveat without naming a directory, from when
// the temp sat with the assets.
let tmpCounter = 0;

/**
 * A file the user picked, as image bytes the server can store, or null when it
 * is not a picture. This is what Insert Image… calls on a Mac. The phone
 * answers the same verb with a photo picker (ios.md §11). The caller runs the
 * picker (`pickImage` in index.ts), and this function reads what it chose.
 *
 * PNG and JPEG pass through untouched. Those are what `assetWrite` stores and
 * what a note can render, and re-encoding a photograph as a lossless PNG
 * multiplies its size by roughly ten. Everything else (a HEIC, a TIFF, a PDF
 * page) goes through `sips`, which ships with macOS and refuses what it cannot
 * decode. A nonzero exit from `sips` means the file was not a picture.
 */
export async function imageFromFile(path: string): Promise<Uint8Array | null> {
  const original = await readFile(path).catch(() => null);
  if (!original) return null;
  const bytes = new Uint8Array(original);
  const png = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (png || jpeg) return bytes;

  await ensureClientHome();
  tmpCounter += 1;
  const tmp = join(CLIENT_HOME, `.pick.tmp-${process.pid}-${tmpCounter}.png`);
  try {
    const p = Bun.spawn(["sips", "-s", "format", "png", path, "--out", tmp], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await p.exited) !== 0) return null;
    return new Uint8Array(await readFile(tmp));
  } catch {
    return null; // no sips (non-macOS), or the file was not a picture
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function readClipboardImage(): Promise<Uint8Array | null> {
  await ensureClientHome();
  tmpCounter += 1;
  const tmp = join(CLIENT_HOME, `.paste.tmp-${process.pid}-${tmpCounter}`);
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
    return new Uint8Array(await readFile(tmp));
  } catch {
    return null; // no osascript (non-macOS), or the write failed: no image
  } finally {
    // Unlink the temp this function wrote. Removing a temp is not one of the
    // three note unlinks architecture.md §3 lists, and `writeNote` unlinks its
    // own temp too, on its error path.
    await unlink(tmp).catch(() => {});
  }
}
