// The native menu bar's bridge, wired by main.tsx (configureMenu) the way
// configureClipboard wires the clipboard: the menu is built from the command
// registry view-side, but only Bun can hand it to AppKit.
//
// Both directions live here so CommandProvider — which owns the build and the
// exec — never imports the RPC, and so the whole thing is inert in a plain
// browser (the Vite dev server, the e2e harness), where there is no menu bar
// to install and no clicks to receive.
//
// The inbound half has two callers now and is named for neither: the Mac's
// menu bar and the phone's keyboard accessory bar (ios.md §7) are both native
// chrome that knows a command id and nothing else about what it does. Adding
// a second identical channel for the second surface would have meant two ways
// for native code to run a verb, which is one more than there should be.
import type { AppMenuItem } from "../../shared/rpc-schema";

let nativeSet: ((items: AppMenuItem[]) => void) | null = null;
let onCommand: ((action: string) => void) | null = null;

export function configureMenu(fns: { set: (items: AppMenuItem[]) => void }): void {
  nativeSet = fns.set;
}

export function setAppMenu(items: AppMenuItem[]): void {
  nativeSet?.(items);
}

// CommandProvider registers the exec; returns the unsubscribe its effect
// needs, so a remount cannot leave a stale closure holding the old registry.
export function onNativeCommand(fn: (action: string) => void): () => void {
  onCommand = fn;
  return () => {
    if (onCommand === fn) onCommand = null;
  };
}

/**
 * Run a command some native chrome named: a menu item on the Mac, an accessory
 * bar button on a phone.
 *
 * A silent no-op before CommandProvider mounts, and after it unmounts. That is
 * the honest behavior for both callers — a tap on a bar whose registry is not
 * there yet has nothing it could mean — and it is why neither surface needs to
 * know whether the view is ready.
 */
export function dispatchNativeCommand(action: string): void {
  onCommand?.(action);
}
