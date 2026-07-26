/**
 * Regenerates assets/Ledge.icon/Assets/mark.svg from assets/logo.svg.
 *
 * The brand mark is drawn on its own small viewBox and inherits `currentColor`,
 * neither of which suits an app icon: Icon Composer wants a 1024-unit canvas
 * with the glyph centred on the icon grid and an explicit fill. This re-frames
 * and colours it.
 *
 * The mark carries the brand accent and sits on the near-black field declared
 * in icon.json.
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
