// Where a menu goes once you know how big it is.
//
// A context menu hangs off a point — a right-click, or the finger of a long
// press (interactions.md §1a) — and the point can be anywhere, including the
// last row of a list at the bottom of a phone. The rule is the platform's: put
// it below the point when it fits there, above when it does not, and never
// past an edge, because a menu item you cannot see is a verb the user does not
// have.
//
// Pure, so the arithmetic is tested rather than eyeballed; ContextMenu.tsx is
// the wrapper that measures and applies it.

// The gap the menu keeps from every edge. Small: this is a fallback for the
// cases the anchor did not anticipate, not a layout.
export const MENU_MARGIN = 8;

export interface MenuSize {
  w: number;
  h: number;
}

export interface MenuPoint {
  x: number;
  y: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

export function placeMenu(at: MenuPoint, menu: MenuSize, view: MenuSize): MenuPoint {
  // Horizontally the menu slides back onto the screen rather than flipping:
  // it hangs to the RIGHT of the press, and flipping it left near the right
  // edge would put it under the hand that opened it.
  const x = clamp(at.x, MENU_MARGIN, Math.max(MENU_MARGIN, view.w - menu.w - MENU_MARGIN));
  // Vertically it flips, because sliding would cover the row it is about. A
  // menu taller than the space above AND below (more items than screen, which
  // no menu here has) pins to the top and is clipped at the bottom rather than
  // starting off screen.
  const raw = at.y + menu.h + MENU_MARGIN <= view.h ? at.y : at.y - menu.h;
  const y = clamp(raw, MENU_MARGIN, Math.max(MENU_MARGIN, view.h - menu.h - MENU_MARGIN));
  return { x, y };
}
