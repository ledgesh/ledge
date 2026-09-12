import { useSyncExternalStore } from "react";

// How wide the window has to be before the panes sit side by side. Below it
// the sidebar and the right-hand panel stop taking width and cover the editor
// instead. The rule is a width and not a device. A phone is the case it was
// written for, and a Mac window dragged this narrow takes the same branch. The
// e2e phone project is desktop WebKit at 390 points (playwright.config.ts),
// and it must take the phone's branch or it tests a layout nobody ships.
//
// The reasons for 640 rather than a phone's own 390-440 are in ios.md §9: the
// sidebar's 180-point floor (App.tsx SIDEBAR_MIN), and the iPad in portrait
// (744) that §7 wants on the pane branch.
export const PANES_MIN_WIDTH = 640;

/** Whether a window shows one pane at a time, as a function of width alone. */
export function isSinglePane(width: number): boolean {
  return width < PANES_MIN_WIDTH;
}

// The media query below tests width alone, not `(pointer: coarse)`. A
// touchscreen laptop is a coarse pointer at 1920 points, and it keeps its
// side-by-side panes instead of a sidebar covering its editor.
const media =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(`(max-width: ${PANES_MIN_WIDTH - 1}px)`)
    : null;

function subscribe(cb: () => void): () => void {
  media?.addEventListener("change", cb);
  return () => media?.removeEventListener("change", cb);
}

/**
 * Whether the chrome shows one pane at a time. This subscribes to the media
 * query instead of taking a boot-time snapshot the way settings are read, so
 * rotating a phone or dragging a window across the breakpoint re-renders.
 */
export function useSinglePane(): boolean {
  return useSyncExternalStore(subscribe, () => media?.matches ?? false);
}

// Whether the pointer is a finger. A different question from the width above,
// and the answer is not the same on either of the two clients that disagree:
// a touchscreen laptop is coarse at 1920 points, and a Mac window dragged to
// 390 still has a mouse. The CSS asks it as `@media (hover: none)`
// (index.css), and this is that query for the sizes script works out instead
// (editor/livePreview.ts).
const hoverless =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(hover: none)")
    : null;

/** Whether this client points with a finger, and so takes the touch column's
 * target sizes (interactions.md §1a). */
export function isTouchPointer(): boolean {
  return hoverless?.matches ?? false;
}
