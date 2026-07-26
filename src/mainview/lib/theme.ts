// Which appearance the app is wearing right now, and the one place that says
// so. Two consumers need the answer in different currencies: CSS reads it as
// `data-theme` on <html> (index.css keys its whole palette off that attribute,
// and tailwind's `dark:` variant off the same selector), and the xterm
// instances (terminal/TerminalDrawer.tsx, editor/inlineTerm.ts) need it as a
// boolean at construction plus a change event, because a terminal's colors are
// JS objects, not variables.
//
// The default (`appearance.theme: "system"`) follows the OS, which is why the
// media query survives here even though CSS no longer asks it: with an
// override in play, `prefers-color-scheme` is no longer the truth, so
// everything has to come through this module instead of asking the browser
// directly. index.html stamps the system answer before first paint so a normal
// launch never flashes; applyAppearance() re-stamps once boot has settings,
// which is the only moment an override can be known.
import { settings } from "./settings";
import type { Theme } from "../../shared/settings";

export type Appearance = "light" | "dark";

/** The whole decision: a setting plus what the OS is doing. */
export function resolveAppearance(theme: Theme, systemDark: boolean): Appearance {
  if (theme === "light" || theme === "dark") return theme;
  return systemDark ? "dark" : "light";
}

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const listeners = new Set<(a: Appearance) => void>();
// Before applyAppearance() the settings snapshot has not landed, so "system"
// is the only honest answer — and it matches what index.html already stamped.
let current: Appearance = resolveAppearance("system", media?.matches ?? false);

/**
 * Stamp the resolved appearance and keep it stamped. Called once per launch,
 * right after configureSettings (main.tsx, harness.tsx): settings apply at
 * launch, but the OS appearance keeps moving under a "system" setting, so the
 * media listener stays for the life of the app.
 */
export function applyAppearance(): void {
  apply();
  media?.addEventListener("change", apply);
}

/** For consumers that hold colors rather than read variables (xterm). */
export function isDarkAppearance(): boolean {
  return current === "dark";
}

/** Subscribe to appearance flips; returns the unsubscribe. */
export function onAppearanceChange(fn: (a: Appearance) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Always writes the attribute (cheap, and it is what makes this the source of
// truth even if the pre-paint stamp never ran); notifies only on a real flip.
function apply(): void {
  const next = resolveAppearance(settings().appearance.theme, media?.matches ?? false);
  document.documentElement.dataset.theme = next;
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn(next);
}
