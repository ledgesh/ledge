// The Windows clipboard's entries (bun/winclip.ts): the HTML entry's header of
// byte offsets and its fallbacks, and the bitmap turned into a PNG.
import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { cfHtmlFragment, dibToPng } from "./winclip";

// A CF_HTML entry the way Chromium writes one: a header of zero-padded byte
// offsets, the document, and a trailing NUL.
function entry(fragment: string): Uint8Array {
  const before = "<html><body>\r\n<!--StartFragment-->";
  const after = "<!--EndFragment-->\r\n</body></html>";
  const header = (a: number, b: number, c: number, d: number) =>
    `Version:0.9\r\nStartHTML:${pad(a)}\r\nEndHTML:${pad(b)}\r\nStartFragment:${pad(c)}\r\nEndFragment:${pad(d)}\r\n`;
  const pad = (n: number) => String(n).padStart(10, "0");
  const size = Buffer.byteLength(header(0, 0, 0, 0));
  const start = size + Buffer.byteLength(before);
  const end = start + Buffer.byteLength(fragment);
  const total = end + Buffer.byteLength(after);
  return Buffer.from(header(size, total, start, end) + before + fragment + after + "\0");
}

describe("the HTML entry", () => {
  test("is the fragment between the header's offsets, decoded as UTF-8", () => {
    expect(cfHtmlFragment(entry("<p>Hello <b>café</b> — ok</p>"))).toBe("<p>Hello <b>café</b> — ok</p>");
  });

  test("falls back to the fragment comments when the offsets overrun", () => {
    const bad = Buffer.from("Version:0.9\r\nStartFragment:000900\r\nEndFragment:000990\r\n<html><body><!--StartFragment--><i>x</i><!--EndFragment--></body></html>");
    expect(cfHtmlFragment(bad)).toBe("<i>x</i>");
  });

  test("falls back to the document when there are no comments either", () => {
    expect(cfHtmlFragment(Buffer.from("Version:0.9\r\n<html><body><i>x</i></body></html>"))).toBe("<html><body><i>x</i></body></html>");
    expect(cfHtmlFragment(Buffer.from("Version:0.9\r\n"))).toBe("");
  });
});

// A BITMAPINFOHEADER bitmap of `rows` (top row first, each pixel [r, g, b, a]),
// stored bottom-up unless `topDown`, with rows padded to four bytes.
function dib(rows: number[][][], bits: 24 | 32, opts: { topDown?: boolean; bitfields?: boolean } = {}): Uint8Array {
  const width = rows[0]!.length;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const masks = opts.bitfields ? 12 : 0;
  const out = Buffer.alloc(40 + masks + stride * rows.length);
  out.writeUInt32LE(40, 0);
  out.writeInt32LE(width, 4);
  out.writeInt32LE(opts.topDown ? -rows.length : rows.length, 8);
  out.writeUInt16LE(1, 12);
  out.writeUInt16LE(bits, 14);
  out.writeUInt32LE(opts.bitfields ? 3 : 0, 16);
  if (opts.bitfields) {
    out.writeUInt32LE(0x00ff0000, 40);
    out.writeUInt32LE(0x0000ff00, 44);
    out.writeUInt32LE(0x000000ff, 48);
  }
  rows.forEach((row, y) => {
    const at = 40 + masks + (opts.topDown ? y : rows.length - 1 - y) * stride;
    row.forEach(([r, g, b, a], x) => {
      const i = at + x * (bits / 8);
      out[i] = b!;
      out[i + 1] = g!;
      out[i + 2] = r!;
      if (bits === 32) out[i + 3] = a!;
    });
  });
  return out;
}

// The PNG's size and RGBA pixels, top row first, read back from its chunks.
function decode(png: Uint8Array): { width: number; height: number; pixels: number[][][] } {
  const buf = Buffer.from(png);
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString("latin1");
    const data = buf.subarray(at + 8, at + 8 + len);
    expect(buf.readUInt32BE(at + 8 + len)).toBe(Bun.hash.crc32(buf.subarray(at + 4, at + 8 + len)));
    if (type === "IHDR") [width, height] = [data.readUInt32BE(0), data.readUInt32BE(4)];
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels: number[][][] = [];
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * (width * 4 + 1), (y + 1) * (width * 4 + 1));
    expect(row[0]).toBe(0);
    pixels.push(Array.from({ length: width }, (_, x) => [...row.subarray(1 + x * 4, 5 + x * 4)]));
  }
  return { width, height, pixels };
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [10, 20, 30, 0];

describe("the bitmap as a PNG", () => {
  test("a bottom-up 32-bit bitmap comes out top row first, in RGBA", () => {
    const rows = [[RED, GREEN], [BLUE, CLEAR]];
    expect(decode(dibToPng(dib(rows, 32))!)).toEqual({ width: 2, height: 2, pixels: rows });
  });

  test("a top-down one and a BI_BITFIELDS one read the same", () => {
    const rows = [[RED, GREEN, BLUE]];
    expect(decode(dibToPng(dib(rows, 32, { topDown: true }))!).pixels).toEqual(rows);
    expect(decode(dibToPng(dib(rows, 32, { bitfields: true }))!).pixels).toEqual(rows);
  });

  test("a 24-bit bitmap, its rows padded to four bytes, comes out opaque", () => {
    const rows = [[RED, GREEN, BLUE], [BLUE, RED, GREEN]];
    expect(decode(dibToPng(dib(rows, 24))!).pixels).toEqual(rows);
  });

  test("a 32-bit bitmap whose alpha bytes are all 0 is opaque", () => {
    const rows = [[[1, 2, 3, 0], [4, 5, 6, 0]]];
    expect(decode(dibToPng(dib(rows, 32))!).pixels).toEqual([[[1, 2, 3, 255], [4, 5, 6, 255]]]);
  });

  test("refuses what it does not read", () => {
    const paletted = Buffer.from(dib([[RED]], 32));
    paletted.writeUInt16LE(8, 14);
    expect(dibToPng(paletted)).toBeNull();
    expect(dibToPng(dib([[RED, GREEN]], 32).subarray(0, 44))).toBeNull();
    expect(dibToPng(new Uint8Array(10))).toBeNull();
  });
});
