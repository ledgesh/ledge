// Opens a row's context menu from a right-click or a long press, at the same
// point from one callback, and keeps a press that opened the menu from also
// activating the row. A phone has no right button, so without the press the
// menu would be out of reach, and with it every verb the menu is the only
// home for (interactions.md §1a, R6). The pure predicates below (tested in
// useRowMenu.test.ts) decide which pointers the press is for and when it has
// become a scroll. What is left here is the timer and the DOM.
import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

// How long a finger stays down before the press counts as a menu rather than
// a tap. The platform's own long press is ~500ms and muscle memory is
// calibrated to it, so this is not a setting.
export const PRESS_MS = 500;
// How far the pointer may drift in pixels and still count as a press. A
// finger is never quite still, and a list is always scrollable. Past this the
// gesture was a scroll, and it belongs to the list.
export const PRESS_SLOP = 10;

export interface PressPoint {
  x: number;
  y: number;
}

// Which pointers get the long press: the ones with no other way to a menu.
// A mouse is excluded. It has the right button already, and a held left
// button is how the workspace strip and the tab strip reorder
// (interactions.md R4).
export function pressOpensMenu(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

// Whether the pointer has drifted too far for this to still be a press.
// Compares each axis against the slop rather than computing a distance. The
// gesture a press loses to is a vertical scroll, and the per-axis test is
// enough to catch it.
export function pressMoved(from: PressPoint, to: PressPoint): boolean {
  return Math.abs(to.x - from.x) > PRESS_SLOP || Math.abs(to.y - from.y) > PRESS_SLOP;
}

// Whether the pointer landed on a control inside the row: the workspace row's
// close ✕, the trash row's restore button, the inline rename field. A press on
// one of those is a tap on the control rather than on the row underneath, so
// it opens no menu.
function onOwnControl(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest("button, input, textarea") !== null;
}

// Whether a right-click landed on a list's blank space rather than on one of
// its rows. Rows publish data-target-kind (commands/target.ts). Everything
// else inside a list is chrome (a section heading, the "no notes yet" line),
// and a menu opened there is about the list rather than about a row
// (interactions.md R6b).
export function onBlankSpace(el: EventTarget | null): boolean {
  return !(el instanceof Element) || el.closest("[data-target-kind]") === null;
}

export interface RowMenuProps {
  onContextMenu: (e: MouseEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: (e: PointerEvent) => void;
  onClick: (e: MouseEvent) => void;
}

// Returns the props to spread onto the row element, after the useListNav row
// props (nothing overlaps). `openMenu` opens this row's menu at a point, the
// same callback the right-click uses. `activate` is the row's plain click
// action (open the note, switch to the workspace). The hook runs it from
// onClick below, and skips it after a press opened the menu: WebKit sends a
// click after every touch, and a long press that opened a note as well as its
// menu would act on the row the user was still deciding about
// (interactions.md §1a).
export function useRowMenu(
  openMenu: (x: number, y: number) => void,
  activate?: (e: MouseEvent) => void,
): RowMenuProps {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Where the press started, while it is still a press; null once it is not.
  const from = useRef<PressPoint | null>(null);
  // Whether the press opened a menu. The click handler reads it and skips
  // `activate` for the click WebKit sends after the press.
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    from.current = null;
  }, []);

  // Clears the timer when the row unmounts under a held finger (its note
  // deleted from elsewhere, its workspace switched away). A timer that
  // outlived the row would open a menu for a row that is gone.
  useEffect(() => cancel, [cancel]);

  return {
    onContextMenu: (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY);
    },
    onPointerDown: (e) => {
      fired.current = false;
      if (!pressOpensMenu(e.pointerType) || onOwnControl(e.target)) return;
      // currentTarget is nulled once React is done dispatching, so the row is
      // read now and closed over, not reached for when the timer fires.
      const row = e.currentTarget as HTMLElement;
      const at = { x: e.clientX, y: e.clientY };
      from.current = at;
      timer.current = setTimeout(() => {
        cancel();
        fired.current = true;
        // Focus the row before opening the menu. A phone has no hover, so the
        // focus ring is the only sign of which row the menu is about. The
        // focused row is also what the row verbs act on (interactions.md §1a,
        // R5).
        row.focus();
        openMenu(at.x, at.y);
      }, PRESS_MS);
    },
    onPointerMove: (e) => {
      if (from.current && pressMoved(from.current, { x: e.clientX, y: e.clientY })) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClick: (e) => {
      if (fired.current) {
        fired.current = false;
        return;
      }
      activate?.(e);
    },
  };
}
