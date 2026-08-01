// The system pasteboard. The webview runs under the views:// scheme, which is
// not a secure context, so `navigator.clipboard` is unavailable there and
// copy/paste has to come through this process (rpc-schema, clipboardRead).
//
// Text is `pbcopy`/`pbpaste`. The HTML flavor is not: `pbpaste` reads
// `public.utf8-plain-text`, `public.rtf` and PostScript and nothing else, and
// Electrobun's clipboard FFI reads text and images only. So the rich flavor goes
// through osascript, the same route the pasteboard's image already takes
// (assets.ts) and for the same reason — AppleScript can name a pasteboard type
// this process otherwise has no binding for.
//
// The hex round trip is what `«class HTML»` costs: AppleScript prints raw data
// as `«data HTML3C68…»`, so the bytes come back doubled and are parsed here.
// Text-shaped and small (a pasteboard flavor is a selection, not a file), which
// is why this one does not bother with the temp file `pasteboardImage` uses to
// avoid exactly that doubling for megabyte-sized PNGs.

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

// AppleScript's raw-data literal. Whitespace inside the run is tolerated and
// stripped rather than ending it, in case a long payload ever arrives wrapped;
// the closing guillemet is required, so a run cut short reads as no HTML rather
// than as a truncated document.
const DATA = /data\s+HTML([0-9A-Fa-f\s]*)»/;

/**
 * The HTML bytes out of an osascript run's stdout, or "" when the pasteboard
 * held no HTML (the script answers "none") and when the literal is malformed —
 * a flavor we cannot decode is a flavor we do not have, and the caller still
 * has the plain text.
 *
 * UTF-8 unless a BOM says otherwise: WebKit and every Cocoa app write
 * `public.html` as UTF-8 (their payload even opens with a `<meta charset>`),
 * while a Windows-authored flavor arriving over a remote desktop can be
 * UTF-16 — decoded as UTF-8 that is text interleaved with NULs, which is
 * worse than not pasting at all.
 */
export function htmlFromScriptOutput(out: string): string {
  const hex = DATA.exec(out)?.[1]?.replace(/\s+/g, "") ?? "";
  // An odd nibble count is a literal we did not read the way it was written.
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
// pbpaste is text-only, so this goes through osascript: AppKit promises a PNG
// rendition of whatever image flavor is on the pasteboard (a screenshot IS
// PNG; a browser-copied image is TIFF and converts), and «class PNGf» asks
// for exactly that. The AppleScript writes to a temp file rather than printing
// hex to stdout — same bytes, none of the doubling and parsing this file's
// HTML flavor puts up with for being small.
//
// The temp lands in the CLIENT home, not in the workspace's assets folder: on
// a connection the notes are on another machine, and this is the one seam that
// has to run on the machine holding the pasteboard (remote.md §10). It is
// transient plaintext for a paste into a locked note either way, unlinked
// immediately — the caveat locking.md §5 already documents, now one directory
// over.
let tmpCounter = 0;

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
    await unlink(tmp).catch(() => {}); // discard our own temp, like writeNote
  }
}
