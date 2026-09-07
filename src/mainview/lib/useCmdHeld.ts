import { useSyncExternalStore } from "react";

// Tracks whether Command (Meta) and Control are currently held, shared across
// the app via one set of window listeners (attached only while something
// subscribes). Drives the quick-jump badges. Workspace rows show ⌘1…9 while
// Command is held. Tabs in the focused pane show ^1…9, spelled with an ASCII
// caret, while either key is held. The chords are in commands/keys.ts:
// Command+number selects a workspace, Control+number selects a tab.
let cmd = false;
let ctrl = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === "Meta" && !cmd) ((cmd = true), emit());
  else if (e.key === "Control" && !ctrl) ((ctrl = true), emit());
};
const onKeyUp = (e: KeyboardEvent) => {
  if (e.key === "Meta" && cmd) ((cmd = false), emit());
  else if (e.key === "Control" && ctrl) ((ctrl = false), emit());
};
// Reset both when the window loses focus. An app switch or a native menu can
// swallow the keyup, which would leave a badge showing with nothing held.
const onBlur = () => {
  if (cmd || ctrl) ((cmd = false), (ctrl = false), emit());
};

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    }
  };
}

export function useCmdHeld(): boolean {
  return useSyncExternalStore(subscribe, () => cmd);
}

export function useCtrlHeld(): boolean {
  return useSyncExternalStore(subscribe, () => ctrl);
}
