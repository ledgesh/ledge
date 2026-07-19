// The view's read-only window onto settings, mirroring lib/clipboard.ts:
// main.tsx configures it with the snapshot Bun validated (harness.tsx with a
// fake), and consumers read it at construction time — every editor, terminal,
// and block widget is created after boot, so a plain getter is enough and no
// reactivity is needed. Settings apply at launch, never live (architecture.md,
// "Settings"), which is why there is no subscription here on purpose.
import { DEFAULT_SETTINGS, type Settings } from "../../shared/settings";

interface SettingsHandlers {
  // The settings editor dialog's load/save: raw settings.jsonc text, comments
  // and all (Bun knows where the file lives and seeds the commented template
  // on first read). Saves apply at the next launch, like every setting.
  readSettingsFile: () => Promise<string>;
  writeSettingsFile: (text: string) => Promise<void>;
  // The profile editor's load/save — the same in-app-dialog shape (macOS
  // binds no app to ".env", so there never was an OS-editor path). Bun
  // validates the name.
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

export function readSettingsFile(): Promise<string> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.readSettingsFile();
}

export function writeSettingsFile(text: string): Promise<void> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.writeSettingsFile(text);
}

export function readProfile(name: string): Promise<string> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.readProfile(name);
}

export function writeProfile(name: string, text: string): Promise<void> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.writeProfile(name, text);
}
