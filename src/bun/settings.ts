// The SERVER end of settings: settings.jsonc lives in the app home (~/.ledge),
// beside the workspace registry and the managed workspace folders, and this
// module is the only thing that reads or writes it. Its sections are the ones
// that describe this machine — the shell to spawn, how long the trash keeps
// things, what a code fence runs, where daily notes go. Font sizes and the
// theme are the client's and live in bun/clientSettings.ts (remote.md §5).
//
// Settings stay GLOBAL in the per-workspace world: a shell path and an
// interpreter map are facts about a machine, not about a folder. Read once at
// launch; changes apply at the next launch, never live — restart-applies is
// the policy (architecture.md, "Settings"), not a limitation to fix.
//
// The file is JSONC — comments are its documentation (SETTINGS_TEMPLATE) and
// the ⌘, editor in Ledge is its UI (settingsRead/settingsWrite carry the raw
// text; components/SettingsEditor.tsx). Installs that predate the format keep
// their settings.json: it is renamed to settings.jsonc on first load (JSON is
// valid JSONC, so the bytes are already right), rename-not-copy so there is
// only ever one file being the user's file.
import { join } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, parseSettings, SETTINGS_TEMPLATE, type Settings } from "../shared/settings";
import { stripJsonc } from "../shared/jsonc";
import { APP_HOME, ensureAppHome } from "./workspaces";

export const SETTINGS_PATH = join(APP_HOME, "settings.jsonc");
// The pre-JSONC spelling, kept only for the one-time migration rename.
export const LEGACY_SETTINGS_PATH = join(APP_HOME, "settings.json");

// Read and validate settings.jsonc. Three shapes of trouble, three answers:
// no file → write the commented template (the file is the settings UI, so it
// should document every knob); unparseable JSONC → warn and run on defaults,
// leaving the file byte-for-byte alone (it is the user's file mid-edit, and
// rewriting it would destroy their work to fix a comma); bad values → each
// falls back alone, reported by parseSettings.
export async function loadSettings(): Promise<Settings> {
  const raw = await readSettingsText();
  if (raw === null) {
    await seedDefaultFile();
    return DEFAULT_SETTINGS;
  }
  let json: unknown;
  try {
    json = JSON.parse(stripJsonc(raw));
  } catch (err) {
    console.warn(`[settings] ${SETTINGS_PATH} is not valid JSONC (${err}); running on defaults`);
    return DEFAULT_SETTINGS;
  }
  const { settings, problems } = parseSettings(json, "server");
  for (const p of problems) console.warn(`[settings] ${p}; using the default`);
  return settings;
}

// The file's text, migrating a legacy settings.json into place if that is
// what exists; null when there is nothing to read.
async function readSettingsText(): Promise<string | null> {
  let jsoncMissing = false;
  try {
    return await readFile(SETTINGS_PATH, "utf8");
  } catch (err) {
    jsoncMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  // Migrate only into a confirmed absence: rename clobbers its target, and
  // "did not read" is not "does not exist" (permissions, say) — an existing
  // settings.jsonc we merely could not read must not be overwritten by the
  // legacy file. JSON is valid JSONC, so the migrated bytes are already right.
  if (!jsoncMissing) return null;
  try {
    await rename(LEGACY_SETTINGS_PATH, SETTINGS_PATH);
    console.log(`[settings] migrated settings.json -> settings.jsonc`);
  } catch {
    return null;
  }
  try {
    return await readFile(SETTINGS_PATH, "utf8");
  } catch {
    return null;
  }
}

// "wx": exclusive create. The reads above can fail for reasons other than
// absence (permissions, say), and clobbering an existing file we merely could
// not read would be data loss — if it exists, whatever the reason we couldn't
// read it, leave it be.
async function seedDefaultFile(): Promise<void> {
  await ensureAppHome();
  await writeFile(SETTINGS_PATH, SETTINGS_TEMPLATE, { encoding: "utf8", flag: "wx" }).catch(() => {});
}

// The settings editor's load half (settingsRead): the raw text, with first
// launch (or first ⌘,) seeding the commented template so what opens is a file
// that documents every knob rather than an empty pane.
export async function readSettingsFile(): Promise<string> {
  const raw = await readSettingsText();
  if (raw !== null) return raw;
  await seedDefaultFile();
  try {
    return await readFile(SETTINGS_PATH, "utf8");
  } catch {
    // Unreadable even after seeding (permissions): the editor still opens on
    // the template — a save may fail, but viewing the knobs always works.
    return SETTINGS_TEMPLATE;
  }
}

// What an agent may learn about settings (the MCP `settings` tool): the file's
// raw text, its path, and the problems launch would report. Comments included
// on purpose — SETTINGS_TEMPLATE's comments ARE the knob documentation, so on
// an unmodified install this one read returns both what the user configured
// and what every knob means. Same seeding and legacy-migration path as the ⌘,
// editor, deliberately: one definition of "the settings file's text", and a
// first read that materializes the documented template is exactly what the
// next launch would have written anyway.
//
// Read-only, and there is no writing sibling. The prompt-fence default
// pre-authorizes this server's whole tool namespace (`--allowedTools
// mcp__ledge`, shared/settings.ts), and settings name the shell every future
// block spawns and the interpreter every fence runs — an unreviewed write
// here would change what the user's NEXT run executes. Agents advise; the
// user edits with ⌘,, or an agent's own file tools do it where the diff is
// visible. (The file is the user's own config, readable by any shell the
// agent already has, but a value can still carry a connection string someone
// inlined instead of using a profile: it is their config, not a secret store.)
export async function inspectSettings(): Promise<{ path: string; text: string; problems: string[] }> {
  const text = await readSettingsFile();
  let json: unknown;
  try {
    json = JSON.parse(stripJsonc(text));
  } catch (err) {
    // The launch-time answer, reported rather than repaired: the whole file
    // is skipped for the run and the bytes stay the user's.
    return { path: SETTINGS_PATH, text, problems: [`not valid JSONC (${err}); Ledge would run entirely on defaults`] };
  }
  return { path: SETTINGS_PATH, text, problems: parseSettings(json, "server").problems };
}

// The save half (settingsWrite): the dialog sends the full new text, written
// atomically like a note save (temp in the same dir, then rename) so a crash
// mid-save leaves the old file or the new one, never a truncated half. The
// text is NOT gated on parsing: it is the user's file, and saving a mid-edit
// state they intend to come back to must not be refused — launch-time
// validation already degrades gently (and the dialog shows problems live).
export async function writeSettingsFile(text: string): Promise<void> {
  await ensureAppHome();
  const tmp = SETTINGS_PATH + ".tmp";
  await writeFile(tmp, text, "utf8");
  await rename(tmp, SETTINGS_PATH);
}
