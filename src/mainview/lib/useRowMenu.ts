// The two ways a row's context menu opens, and the click that must not fire
// behind it.
//
// A right-click is a pointer gesture with no touch form (interactions.md §1a):
// a phone has no second button, so the menu — R6's canonical home for every
// row verb — would be unreachable there, and with it every verb that has no
// other surface. A press HELD on the row opens the same menu at the same
// place, so the two inputs meet at one implementation rather than at two
// grammars.
//
// The decisions are pure and tested (which pointers get the gesture, when a
// press has become a scroll); what is left is the timer and the DOM.
import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

// How long a finger stays down before the press is a menu rather than a tap.
// The platform's own long press is ~500ms and muscle memory is calibrated to
// it, so this is not a knob.
export const PRESS_MS = 500;
// How far it may drift on the way and still be a press. A finger is never
// still; a list is always scrollable. Below this the press survives, above it
// the gesture was a scroll and belonged to the list.
export const PRESS_SLOP = 10;

export interface PressPoint {
  x: number;
  y: number;
}

// Which pointers get the long press: the ones with no other way to a menu. A
// mouse is excluded deliberately — it has the right button already, and a held
// left button is how the workspace strip and the tab strip reorder (R4).
export function pressOpensMenu(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

// Has the pointer left the press? Per axis rather than by distance: the
// gesture this loses to is a vertical scroll, and the cheap comparison says
// the same thing about it.
export function pressMoved(from: PressPoint, to: PressPoint): boolean {
  return Math.abs(to.x - from.x) > PRESS_SLOP || Math.abs(to.y - from.y) > PRESS_SLOP;
}

// A control inside a row owns its own press: the workspace row's close ✕, the
// trash row's restore button, the inline rename field. Their gesture is a tap
// on themselves, not a press on the row underneath.
function onOwnControl(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest("button, input, textarea") !== null;
}

export interface RowMenuProps {
  onContextMenu: (e: MouseEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: (e: PointerEvent) => void;
  onClick: (e: MouseEvent) => void;
}

// Spread onto the row element, after the useListNav row props (nothing
// overlaps). `openMenu` is the row's own "open my menu here" — the same
// callback the right-click already had. `activate` is what the row does on a
// plain click (open the note, switch to the workspace), passed through here so
// a press that already opened a menu does not also run it: on touch the click
// arrives after the press, and a long press that opened a note as well as its
// menu would act on the very row the user was still deciding about.
export function useRowMenu(
  openMenu: (x: number, y: number) => void,
  activate?: (e: MouseEvent) => void,
): RowMenuProps {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Where the press started, while it is still a press; null once it is not.
  const from = useRef<PressPoint | null>(null);
  // Whether the press that is ending opened the menu, read by the click that
  // WebKit sends afterwards.
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    from.current = null;
  }, []);

  // A row can unmount under a held finger (its note deleted from elsewhere,
  // its workspace switched away), and a timer that outlives the row would open
  // a menu for a row that is gone.
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
        // Focus the row first. On a phone there is no hover to have said which
        // row this is, so the focus ring is the whole answer to "what is the
        // menu about" — and it is what the row verbs address if a keyboard
        // ever does turn up (interactions.md §1a, R5).
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
