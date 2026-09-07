// The bridge to the native menu bar, configured by boot.tsx (configureMenu)
// the way configureClipboard wires the clipboard. CommandProvider builds the
// menu from the command registry and calls setAppMenu, but only Bun can hand
// the items to AppKit. Both directions live here so CommandProvider never
// imports the RPC. setAppMenu drops the items until configureMenu runs, and
// the e2e harness never calls configureMenu or sends a command back.
//
// The inbound half is named for neither surface. Its two callers are the Mac's
// menu bar and the phone's keyboard accessory bar (ios.md §7), each native
// chrome that passes a command id and knows nothing else about the command.
// One seam serves both, rather than a channel per surface.
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
 * Run a command some native chrome named: a menu item on the Mac, an
 * accessory bar button on a phone. The call is dropped until CommandProvider
 * mounts, and again once it unmounts. A click with no registry mounted names
 * a command nothing can run, so neither surface has to check whether the view
 * is ready.
 */
export function dispatchNativeCommand(action: string): void {
  onCommand?.(action);
}
