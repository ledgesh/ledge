import { useSyncExternalStore } from "react";
import { modKey } from "../commands/modKey";

// Tracks which of Meta, Control and Alt are currently held, shared across the
// app via one set of window listeners (attached only while something
// subscribes). Drives the quick-jump badges. Workspace rows show their jump
// while Mod is held (⌘ on a Mac, Ctrl elsewhere). Tabs in the focused pane
// show theirs while the tab modifier is held: Control on a Mac, Alt where Mod
// is Ctrl (commands/keys.ts tabSelectKey), and Mod itself either way. The
// chords are in commands/keys.ts: Mod+number selects a workspace, the tab
// modifier+number selects a tab.
const held = { Meta: false, Control: false, Alt: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function isTracked(key: string): key is keyof typeof held {
  return key in held;
}

const onKeyDown = (e: KeyboardEvent) => {
  if (isTracked(e.key) && !held[e.key]) ((held[e.key] = true), emit());
};
const onKeyUp = (e: KeyboardEvent) => {
  if (isTracked(e.key) && held[e.key]) ((held[e.key] = false), emit());
};
// Reset all three when the window loses focus. An app switch or a native menu
// can swallow the keyup, which would leave a badge showing with nothing held.
const onBlur = () => {
  if (held.Meta || held.Control || held.Alt) ((held.Meta = held.Control = held.Alt = false), emit());
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

function modIsHeld(): boolean {
  return modKey() === "Meta" ? held.Meta : held.Control;
}

function tabModIsHeld(): boolean {
  return modKey() === "Meta" ? held.Control : held.Alt;
}

/** Whether Mod is held: the workspace badges' cue. */
export function useModHeld(): boolean {
  return useSyncExternalStore(subscribe, modIsHeld);
}

/** Whether the tab jump's modifier is held: the tab badges' cue. */
export function useTabModHeld(): boolean {
  return useSyncExternalStore(subscribe, tabModIsHeld);
}
