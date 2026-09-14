// A pairing code as an SVG path, for the panel that shows one on a Mac
// (components/ConnectionPicker.tsx, remote.md §4b). uqr gives the module grid
// and this draws it, the way bun/pair.ts draws the same grid in a terminal.
import { encode } from "uqr";
import { QR_OPTIONS } from "../../shared/pairing";

/**
 * The dark modules of `text`'s QR code as one path in a `size`-by-`size`
 * viewBox, one unit per module, quiet zone counted in. One square per module
 * rather than merged runs: `shape-rendering="crispEdges"` on the svg keeps
 * neighbours from showing a seam, and a scanner reads modules, not shapes.
 */
export function qrPath(text: string): { size: number; d: string } {
  const { data, size } = encode(text, QR_OPTIONS);
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y]![x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return { size, d };
}
