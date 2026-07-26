// The native menu bar's bridge, wired by main.tsx (configureMenu) the way
// configureClipboard wires the clipboard: the menu is built from the command
// registry view-side, but only Bun can hand it to AppKit.
//
// Both directions live here so CommandProvider — which owns the build and the
// exec — never imports the RPC, and so the whole thing is inert in a plain
// browser (the Vite dev server, the e2e harness), where there is no menu bar
// to install and no clicks to receive.
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
export function onMenuCommand(fn: (action: string) => void): () => void {
  onCommand = fn;
  return () => {
    if (onCommand === fn) onCommand = null;
  };
}

export function dispatchMenuCommand(action: string): void {
  onCommand?.(action);
}
