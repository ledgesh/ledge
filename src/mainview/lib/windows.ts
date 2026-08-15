// New Window, as a seam (architecture.md §5): main.tsx binds `open` to the
// windowNew RPC, the harness binds a stub, and the command registry reaches it
// through openWindow without importing either.
//
// A window is a client, not a second view of one (remote.md §8a): the shell
// opens it on the local server the way a launch does, and everything about
// which machine it ends up on is the ordinary Notes On… from inside it. So
// there is nothing to pass and nothing to hear back — whether the verb should
// have been offered at all is lib/shell.ts's multiWindow, asked before the
// call rather than learned from it.
export interface WindowHandlers {
  open(): void;
}

let handlers: WindowHandlers | null = null;

export function configureWindows(h: WindowHandlers): void {
  handlers = h;
}

export function openWindow(): void {
  handlers?.open();
}
