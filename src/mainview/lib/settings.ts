// The view's read-only window onto settings: a configureSettings call plus
// plain getters, the shape lib/clipboard.ts uses. boot.tsx passes the snapshot
// Bun validated, harness.tsx passes a fake. Editors, terminals, and block
// widgets are built after boot and read settings as they are constructed.
// Settings apply at launch, never live (architecture.md §6), so there is no
// subscribe call here.
import { DEFAULT_SETTINGS, type Settings, type SettingsHome } from "../../shared/settings";

interface SettingsHandlers {
  // The settings editor dialog's load and save: the raw settings.jsonc text,
  // comments and all. Bun resolves the path for each home and seeds the
  // commented template on first read. `home` picks the file: "server" is the
  // machine holding the notes and "client" is this app on this screen
  // (remote.md §5). A save applies at the next launch, like every setting.
  readSettingsFile: (home: SettingsHome) => Promise<string>;
  writeSettingsFile: (home: SettingsHome, text: string) => Promise<void>;
  // The profile editor loads and saves one profile's env file through its own
  // in-app dialog. macOS binds no app to ".env", so these files never had an
  // OS-editor path. Bun validates the name (bun/profiles.ts).
  readProfile: (name: string) => Promise<string>;
  writeProfile: (name: string, text: string) => Promise<void>;
}

// The defaults until configureSettings runs, so settings() answers with a
// whole Settings before the boot snapshot arrives.
let current: Settings = DEFAULT_SETTINGS;
let handlers: SettingsHandlers | null = null;

export function configureSettings(snapshot: Settings, h: SettingsHandlers): void {
  current = snapshot;
  handlers = h;
}

export function settings(): Settings {
  return current;
}

export function readSettingsFile(home: SettingsHome): Promise<string> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.readSettingsFile(home);
}

export function writeSettingsFile(home: SettingsHome, text: string): Promise<void> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.writeSettingsFile(home, text);
}

export function readProfile(name: string): Promise<string> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.readProfile(name);
}

export function writeProfile(name: string, text: string): Promise<void> {
  if (!handlers) throw new Error("settings bridge not configured");
  return handlers.writeProfile(name, text);
}
