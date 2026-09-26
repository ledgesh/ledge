/**
 * Regenerates assets/Ledge.icon/Assets/mark.svg from assets/logo.svg, and
 * assets/Ledge.png and assets/Ledge.ico from that.
 *
 * The brand mark is drawn on its own small viewBox and inherits
 * `currentColor`. Icon Composer wants a 1024-unit canvas with the glyph centred
 * on the icon grid and an explicit fill, so this re-frames the mark and colours
 * it with the brand accent, over the near-black field icon.json declares.
 *
 * The PNG is the Linux icon (electrobun.config.ts `build.linux.icon`): the
 * same mark on the same field, with the corners macOS would cut, rasterized
 * by the suite's headless WebKit because a Linux build has no Icon Composer
 * to ask. The .ico is the Windows icon (`build.win.icon`), the same picture
 * rendered at each size Windows asks for, since Hutch refuses a PNG over 256
 * pixels. Both are committed, so a Linux or Windows runner never needs this
 * script.
 */

const CANVAS = 1024;
const GLYPH_FIT = 680; // longest edge; fills the squircle without crowding its corners
const MARK_COLOR = "#E6F256"; // 13.7:1 against the icon.json background

const source = await Bun.file("assets/logo.svg").text();

const viewBox = source.match(/viewBox="([\d.\s-]+)"/)?.[1]?.trim().split(/\s+/).map(Number);
if (viewBox?.length !== 4) throw new Error("assets/logo.svg: could not read a 4-value viewBox");
const [vx, vy, vw, vh] = viewBox;

const inner = source
  .slice(source.indexOf(">", source.indexOf("<svg")) + 1, source.lastIndexOf("</svg>"))
  .trim()
  // the logo inherits its colour from context; the icon must state one
  .replace(/\bcurrentColor\b/g, MARK_COLOR);

const scale = GLYPH_FIT / Math.max(vw, vh);
const tx = (CANVAS - vw * scale) / 2 - vx * scale;
const ty = (CANVAS - vh * scale) / 2 - vy * scale;

const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none">
<g transform="translate(${tx.toFixed(4)} ${ty.toFixed(4)}) scale(${scale.toFixed(6)})" fill="${MARK_COLOR}">
${inner}
</g>
</svg>
`;

await Bun.write("assets/Ledge.icon/Assets/mark.svg", mark);
console.log(
  `mark.svg: ${(vw * scale).toFixed(0)}x${(vh * scale).toFixed(0)} at (${tx.toFixed(0)}, ${ty.toFixed(0)})`,
);

// icon.json's fill, as a hex color, and the corner radius macOS applies to a
// 1024-unit icon. The composed SVG is screenshotted from a page with no
// background, so the corners come out transparent: QuickLook's `qlmanage`
// renders the same SVG but flattens it onto white, which is a white border
// on a dark desktop.
const FIELD = "#1a1a1a";
const CORNER = 229;
const composed = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
<rect width="${CANVAS}" height="${CANVAS}" rx="${CORNER}" ry="${CORNER}" fill="${FIELD}"/>
${mark.slice(mark.indexOf(">", mark.indexOf("<svg")) + 1, mark.lastIndexOf("</svg>")).trim()}
</svg>
`;
const { webkit } = await import("playwright");
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: CANVAS, height: CANVAS }, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${composed}</body></html>`);
await page.screenshot({ path: "assets/Ledge.png", omitBackground: true, clip: { x: 0, y: 0, width: CANVAS, height: CANVAS } });
console.log(`Ledge.png: ${CANVAS}x${CANVAS}`);

// Each size is rendered from the vector rather than scaled down from the
// 1024 PNG, so the small ones stay sharp. The list covers the taskbar and
// title bar at 100% to 250% display scaling: Windows scales the nearest
// size it finds, which blurs.
const ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256];
const pngs: Uint8Array[] = [];
for (const size of ICO_SIZES) {
  await page.setViewportSize({ width: size, height: size });
  const svg = composed.replace(`width="${CANVAS}" height="${CANVAS}"`, `width="${size}" height="${size}"`);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  pngs.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}
await browser.close();

// An ICO is a 6-byte header, a 16-byte entry per image, then the images. Each
// image here is a whole PNG, which Windows reads at every size since Vista.
// A width or height of 256 is written as 0.
const header = 6 + 16 * pngs.length;
const ico = new Uint8Array(header + pngs.reduce((n, p) => n + p.length, 0));
const view = new DataView(ico.buffer);
view.setUint16(2, 1, true);
view.setUint16(4, pngs.length, true);
let offset = header;
for (const [i, png] of pngs.entries()) {
  const at = 6 + 16 * i;
  const size = ICO_SIZES[i]! % 256;
  view.setUint8(at, size);
  view.setUint8(at + 1, size);
  view.setUint16(at + 4, 1, true);
  view.setUint16(at + 6, 32, true);
  view.setUint32(at + 8, png.length, true);
  view.setUint32(at + 12, offset, true);
  ico.set(png, offset);
  offset += png.length;
}
await Bun.write("assets/Ledge.ico", ico);
console.log(`Ledge.ico: ${ICO_SIZES.join(", ")}`);
