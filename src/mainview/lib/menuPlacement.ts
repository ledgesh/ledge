// ContextMenu.tsx measures the menu; this places it. The rule comes from
// macOS: below the point when the menu fits, above it when it does not, never
// past a viewport edge. A menu item you cannot see is a verb the user does not
// have (interactions.md §1a). The point is a right-click, a long press, or an
// anchor the caller computes (pickerAnchor in editor/blocks.ts), and it can be
// anywhere, including the last row of a list at the bottom of a phone. Keeping
// this module pure lets menuPlacement.test.ts check the arithmetic.

// The gap the menu keeps from every viewport edge. Small: where the menu goes
// is normally decided by where the caller anchors it, and this is the backstop
// for the cases the anchor did not anticipate, not general layout spacing.
// placeMenu also counts this gap when deciding whether the menu fits below the
// point, so a menu with less room than this below it flips above instead.
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
  // Horizontally the menu slides back into the viewport rather than flipping.
  // It hangs to the right of the point. Flipping it to the left near the right
  // edge would put it under the hand that opened it.
  const x = clamp(at.x, MENU_MARGIN, Math.max(MENU_MARGIN, view.w - menu.w - MENU_MARGIN));
  // Vertically the menu flips rather than sliding. Sliding would cover the row
  // the menu is about. A menu that cannot fit the viewport at any position
  // (more items than fit in the window, which no menu here has) pins to the
  // top and is clipped at the bottom rather than starting above the top edge.
  const raw = at.y + menu.h + MENU_MARGIN <= view.h ? at.y : at.y - menu.h;
  const y = clamp(raw, MENU_MARGIN, Math.max(MENU_MARGIN, view.h - menu.h - MENU_MARGIN));
  return { x, y };
}
