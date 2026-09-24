/**
 * Regenerates assets/Ledge.icon/Assets/mark.svg from assets/logo.svg, and
 * assets/Ledge.png from that.
 *
 * The brand mark is drawn on its own small viewBox and inherits
 * `currentColor`. Icon Composer wants a 1024-unit canvas with the glyph centred
 * on the icon grid and an explicit fill, so this re-frames the mark and colours
 * it with the brand accent, over the near-black field icon.json declares.
 *
 * The PNG is the Linux icon (electrobun.config.ts `build.linux.icon`): the
 * same mark on the same field, with the corners macOS would cut, rasterized
 * by the suite's headless WebKit because a Linux build has no Icon Composer
 * to ask. It is committed, so a Linux runner never needs this script.
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
await browser.close();
console.log(`Ledge.png: ${CANVAS}x${CANVAS}`);
