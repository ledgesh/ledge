import { useSyncExternalStore } from "react";

// Tracks whether Command (Meta) and Control are currently held, shared across the
// app via a single set of window listeners (attached only while something
// subscribes). Drives the quick-jump badges: ⌘N on workspaces (Cmd held) and ^N
// on tabs (Cmd OR Ctrl held), advertising Cmd+number → workspace and
// Ctrl+number → tab.
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
// Releasing focus (app switch, native menu) can swallow the keyup, so reset both
// to avoid a badge that sticks on.
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
