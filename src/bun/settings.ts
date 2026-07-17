// The Bun end of settings: settings.json lives in the app home (~/.ledge),
// beside the workspace registry and the managed workspace folders, and this
// module is the only thing that reads or writes it. Settings stay GLOBAL in
// the per-workspace world: shell path, font sizes, and interpreters are facts
// about the person, not the folder. Read once at launch (index.ts); changes
// apply at the next launch, never live — restart-applies is the policy
// (docs/architecture.md, "Settings"), not a limitation to fix.
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, parseSettings, type Settings } from "../shared/settings";
import { APP_HOME, ensureAppHome } from "./workspaces";

export const SETTINGS_PATH = join(APP_HOME, "settings.json");

// Read and validate settings.json. Three shapes of trouble, three answers:
// no file → write the defaults out in full (the file is the settings UI, so it
// should document every knob); unparseable JSON → warn and run on defaults,
// leaving the file byte-for-byte alone (it is the user's file mid-edit, and
// rewriting it would destroy their work to fix a comma); bad values → each
// falls back alone, reported by parseSettings.
export async function loadSettings(): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(SETTINGS_PATH, "utf8");
  } catch {
    await seedDefaultFile();
    return DEFAULT_SETTINGS;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.warn(`[settings] ${SETTINGS_PATH} is not valid JSON (${err}); running on defaults`);
    return DEFAULT_SETTINGS;
  }
  const { settings, problems } = parseSettings(json);
  for (const p of problems) console.warn(`[settings] ${p}; using the default`);
  return settings;
}

// "wx": exclusive create. The read above can fail for reasons other than
// absence (permissions, say), and clobbering an existing file we merely could
// not read would be data loss — if it exists, whatever the reason we couldn't
// read it, leave it be.
async function seedDefaultFile(): Promise<void> {
  await ensureAppHome();
  await writeFile(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  }).catch(() => {});
}

// Open settings.json in whatever the OS considers its editor (⌘, routes here
// over RPC). Ensures the file exists first, so the very first ⌘, opens a file
// full of documented defaults instead of a "no such file" dialog.
export async function openSettingsFile(): Promise<void> {
  await loadSettings();
  try {
    Bun.spawn(["open", SETTINGS_PATH]);
  } catch (err) {
    console.warn("[settings] could not open the settings file", err);
  }
}
