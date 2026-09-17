import { useSyncExternalStore } from "react";

// How wide the window has to be before the panes sit side by side. Below it
// the sidebar and the right-hand panel stop taking width and cover the editor
// instead. The rule is a shape and not a device. A phone is the case it was
// written for, and a Mac window dragged this narrow takes the same branch. The
// e2e phone project is desktop WebKit at 390 points (playwright.config.ts),
// and it must take the phone's branch or it tests a layout nobody ships.
//
// The reasons for 640 rather than a phone's own 390-440 are in ios.md §9: the
// sidebar's 180-point floor (App.tsx SIDEBAR_MIN), and the iPad in portrait
// (744) that §7 wants on the pane branch.
export const PANES_MIN_WIDTH = 640;

// The shape's other axis. A phone turned on its side is 734 to 840 points wide
// and clears the width rule, but it is 372 to 410 points tall, and the sidebar
// beside the editor cannot fit its own rows in that (ios.md §9). The test is
// the SCREEN's shorter side, not the viewport's height: the web view is
// constrained to the keyboard (ios/Sources/WebHost.swift), so its height
// drops by half whenever the keyboard comes up, and a height query would flip
// an iPad's arrangement mid-word. The screen never changes with the keyboard.
// 500 sits between the widest phone (440) and the narrowest iPad (744), and a
// Mac has no screen that small.
export const PHONE_SCREEN_MAX = 500;

/** Whether a window shows one pane at a time: too narrow for two, or on a
 * screen too small for two whichever way it is turned. */
export function isSinglePane(width: number, screenShortSide = Infinity): boolean {
  return width < PANES_MIN_WIDTH || screenShortSide < PHONE_SCREEN_MAX;
}

// Read on every snapshot rather than once. A device's screen never changes
// while the page lives, but Playwright's WebKit reports the viewport as the
// screen, so the e2e harness's screen follows setViewportSize and a stale read
// would keep the phone project on one pane at 1200 points (phone.spec.ts).
const shortSide = () =>
  typeof screen !== "undefined" ? Math.min(screen.width, screen.height) : Infinity;

// The media query below tests width alone, not `(pointer: coarse)`. A
// touchscreen laptop is a coarse pointer at 1920 points, and it keeps its
// side-by-side panes instead of a sidebar covering its editor.
const media =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(`(max-width: ${PANES_MIN_WIDTH - 1}px)`)
    : null;

// The resize listener is for the harness's screen, which moves with the
// viewport (shortSide above); on a device only the media query ever fires.
function subscribe(cb: () => void): () => void {
  media?.addEventListener("change", cb);
  window.addEventListener("resize", cb);
  return () => {
    media?.removeEventListener("change", cb);
    window.removeEventListener("resize", cb);
  };
}

/**
 * Whether the chrome shows one pane at a time. This subscribes to the media
 * query instead of taking a boot-time snapshot the way settings are read, so
 * dragging a window across the breakpoint re-renders. A phone's answer is the
 * same in both orientations, so rotating one changes nothing here.
 */
export function useSinglePane(): boolean {
  return useSyncExternalStore(subscribe, () =>
    isSinglePane(media?.matches ? 0 : PANES_MIN_WIDTH, shortSide()),
  );
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
