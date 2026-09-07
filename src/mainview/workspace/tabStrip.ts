// Pure decisions behind the tab strip's scrolling (PaneTree.tsx). The strip
// scrolls horizontally with its scrollbar hidden (index.css .ledge-tabstrip).
// These two functions answer which edges are currently hiding tabs (drawn as
// the fade masks that stand in for the scrollbar), and what a wheel tick over
// the strip should do.

// Which edges of the strip clip content, given its scroll metrics. The 1px
// slack absorbs the fractional scroll positions WebKit reports on retina
// displays. At the far end, scrollLeft can sit just shy of
// scrollWidth - clientWidth.
export function clippedEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: boolean; right: boolean } {
  return {
    left: scrollLeft > 1,
    right: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

// Horizontal travel for a wheel event over the strip. A dominant deltaY is
// remapped sideways. The strip has no vertical axis, and a mouse wheel emits
// deltaY. A trackpad pan with a dominant deltaX already scrolls the strip
// natively. That case must return 0, or the gesture would be applied twice.
export function wheelTravel(deltaX: number, deltaY: number): number {
  return Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : 0;
}
