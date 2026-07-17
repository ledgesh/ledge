// Pure decisions behind the tab strip's scrolling (PaneTree.tsx). The strip
// scrolls horizontally with its scrollbar hidden (index.css .ledge-tabstrip),
// so these answer the two questions that replaces: which edges are currently
// hiding tabs (drawn as fade masks), and what a wheel tick over the strip
// should do.

// Which edges of the strip clip content, given its scroll metrics. The 1px
// slack absorbs the fractional scroll positions WebKit reports on retina
// displays, where scrollLeft at the far end can sit just shy of
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

// Horizontal travel for a wheel event over the strip. A mouse wheel is a
// vertical device and the strip has no vertical axis, so a dominant deltaY is
// remapped sideways. A trackpad pan with dominant deltaX already scrolls the
// strip natively and must return 0, or the gesture would be applied twice.
export function wheelTravel(deltaX: number, deltaY: number): number {
  return Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : 0;
}
