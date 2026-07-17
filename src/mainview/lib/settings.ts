// The view's read-only window onto settings, mirroring lib/clipboard.ts:
// main.tsx configures it with the snapshot Bun validated (harness.tsx with a
// fake), and consumers read it at construction time — every editor, terminal,
// and block widget is created after boot, so a plain getter is enough and no
// reactivity is needed. Settings apply at launch, never live (architecture.md,
// "Settings"), which is why there is no subscription here on purpose.
import { DEFAULT_SETTINGS, type Settings } from "../../shared/settings";

interface SettingsHandlers {
  // Open settings.json in the OS editor (Bun knows where it lives).
  openFile: () => void;
  // The profile editor's load/save. Profiles do not go through the OS editor
  // like settings.json — macOS binds no app to ".env" — so Ledge's own dialog
  // is the UI and these are its two edges. Bun validates the name.
  readProfile: (name: string) => Promise<string>;
  writeProfile: (name: string, text: string) => Promise<void>;
}

// Defaults until configured: a boot that failed to reach Bun still renders,
// and DEFAULT_SETTINGS is exactly what Bun would have sent for a missing file.
let current: Settings = DEFAULT_SETTINGS;
let handlers: SettingsHandlers | null = null;

export function configureSettings(snapshot: Settings, h: SettingsHandlers): void {
  current = snapshot;
  handlers = h;
}

export function settings(): Settings {
  return current;
}

export function openSettingsFile(): void {
  if (!handlers) throw new Error("settings bridge not configured");
  handlers.openFile();
}

export function readProfile(name: string): Promise<string> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.readProfile(name);
}

export function writeProfile(name: string, text: string): Promise<void> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.writeProfile(name, text);
}
