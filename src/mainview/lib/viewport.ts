import { useSyncExternalStore } from "react";

// How wide the window has to be before the panes sit side by side, and the one
// place that says so.
//
// Below this, the sidebar and the right-hand panel stop taking width and start
// covering the editor instead (ios.md §9). The number is a width and not a
// device: a phone is the case it was written for, but a Mac window dragged
// this narrow has the same problem and gets the same answer, and the e2e phone
// project is a desktop WebKit at 390 points that has to take the phone's
// branch or it would be testing a layout nobody ships.
//
// 640 rather than a phone's own 390-440: the sidebar's floor is 180 points
// (App.tsx SIDEBAR_MIN), so the side-by-side arrangement stops being usable
// well before it stops being possible. It also leaves an iPad in portrait
// (744) on the desktop branch, which §7 wants — an iPad with a keyboard is a
// Mac-shaped client and the panes are right for it.
export const PANES_MIN_WIDTH = 640;

/** The whole decision, as a function of width alone. */
export function isSinglePane(width: number): boolean {
  return width < PANES_MIN_WIDTH;
}

// Deliberately width and not `(pointer: coarse)`: a touchscreen laptop is a
// coarse pointer at 1920 points, and covering its editor with a sidebar
// because it can be touched would be the wrong answer to the right question.
const media =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(`(max-width: ${PANES_MIN_WIDTH - 1}px)`)
    : null;

function subscribe(cb: () => void): () => void {
  media?.addEventListener("change", cb);
  return () => media?.removeEventListener("change", cb);
}

/**
 * Whether the chrome shows one pane at a time. Live: rotating a phone or
 * dragging a window across the breakpoint re-renders, which is why this is a
 * media query subscription rather than a boot-time snapshot the way settings
 * are.
 */
export function useSinglePane(): boolean {
  return useSyncExternalStore(subscribe, () => media?.matches ?? false);
}
