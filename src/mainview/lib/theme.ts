// The app's current appearance, and the one place that resolves it. CSS reads
// it as `data-theme` on <html>: index.css keys its palette off that attribute,
// and tailwind's `dark:` variant off the same selector. The xterm instances
// (terminal/TerminalDrawer.tsx, editor/inlineTerm.ts) read it as a boolean at
// construction plus a change event, because a terminal's colors are JS objects
// rather than CSS variables.
//
// The default (`appearance.theme: "system"`) follows the OS, so the media
// query stays here even though CSS no longer asks it. A setting can override
// the OS, so `prefers-color-scheme` is no longer the truth: the xterms and any
// new consumer must take the answer from this module rather than opening their
// own matchMedia (architecture.md §6). index.html stamps the system answer
// before first paint, so a normal launch never flashes. applyAppearance()
// re-stamps once boot has settings, the only moment the app can see an
// override.
import { settings } from "./settings";
import type { Theme } from "../../shared/settings";

export type Appearance = "light" | "dark";

/** Resolves the appearance from the `theme` setting and the OS appearance. */
export function resolveAppearance(theme: Theme, systemDark: boolean): Appearance {
  if (theme === "light" || theme === "dark") return theme;
  return systemDark ? "dark" : "light";
}

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const listeners = new Set<(a: Appearance) => void>();
// Before applyAppearance() runs, the settings snapshot has not landed, so
// "system" is the only answer this module can give yet. It matches what
// index.html stamped.
let current: Appearance = resolveAppearance("system", media?.matches ?? false);

/**
 * Stamps the resolved appearance on <html> and keeps it stamped. boot.tsx and
 * harness.tsx call it once per launch, right after configureSettings. The
 * media listener stays registered for the life of the app: settings apply at
 * launch (architecture.md §6), but the OS appearance can change while the app
 * runs.
 */
export function applyAppearance(): void {
  apply();
  media?.addEventListener("change", apply);
}

/** True when the appearance is dark, for consumers that hold color objects
 * rather than read CSS variables (xterm). */
export function isDarkAppearance(): boolean {
  return current === "dark";
}

/** Subscribes to appearance changes. Returns the unsubscribe function. */
export function onAppearanceChange(fn: (a: Appearance) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Writes the attribute on every call. The write is cheap, and it is what
// makes this module the source of truth even when the pre-paint stamp never
// ran. It notifies listeners only when the appearance changes.
function apply(): void {
  const next = resolveAppearance(settings().appearance.theme, media?.matches ?? false);
  document.documentElement.dataset.theme = next;
  stampThemeColor();
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn(next);
}

// The page's background, published as `theme-color` for the shell around it.
// The iOS web view is pinned inside the safe areas (ios/Sources/WebHost.swift),
// so the root view shows through beside a phone on its side and under the
// home indicator, and it reads this back as the web view's `themeColor` to
// paint itself the same. Read from the stamped palette rather than named
// here, so a palette change cannot leave the bands a different dark.
function stampThemeColor(): void {
  const token = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  if (!token) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = `hsl(${token})`;
}
