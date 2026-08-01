// The client's half of settings: font sizes, the theme, live preview.
//
// bun/settings.ts is this module's server-side sibling and the two are
// deliberately near-identical — same JSONC, same seed-the-commented-template
// on first read, same atomic save, same restart-applies policy. What differs
// is whose fact the file holds (shared/settings.ts SETTINGS_HOMES) and where
// it lives: the client home, so it stays with the app when the app connects to
// another machine's notes (remote.md §5).
//
// It also owns the one-time split. An install from before the boundary existed
// has all seven sections in the server's settings.jsonc; the first launch after
// lifts the client-owned values out of it into a file of their own, so nobody's
// font size resets to 14 because the architecture moved. The server's copy is
// left exactly as it was — it is the user's file, and rewriting someone's
// commented config to delete four lines is not a migration's business.
// parseSettings reports those leftovers, which is how they get deleted: by
// their owner, when they feel like it.
import { join } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
  clientSettingsTemplate,
  DEFAULT_SETTINGS,
  parseSettings,
  type Settings,
} from "../shared/settings";
import { stripJsonc } from "../shared/jsonc";
import { CLIENT_HOME, ensureClientHome } from "./clientHome";
import { SETTINGS_PATH } from "./settings";

export const CLIENT_SETTINGS_PATH = join(CLIENT_HOME, "settings.jsonc");

/**
 * Read and validate the client's settings. The three shapes of trouble get the
 * same three answers as the server's file: no file yet means seed one (the
 * split first, if there is anything to split); unparseable means warn and run
 * on defaults with the bytes untouched, because it is the user's file mid-edit;
 * a bad value falls back alone.
 */
export async function loadClientSettings(): Promise<Settings> {
  const raw = await readClientSettingsFile();
  let json: unknown;
  try {
    json = JSON.parse(stripJsonc(raw));
  } catch (err) {
    console.warn(`[settings] ${CLIENT_SETTINGS_PATH} is not valid JSONC (${err}); running on defaults`);
    return DEFAULT_SETTINGS;
  }
  const { settings, problems } = parseSettings(json, "client");
  for (const p of problems) console.warn(`[settings] ${p}; using the default`);
  return settings;
}

/**
 * The file's raw text, seeding it when there is none. The seed is the split
 * when an older settings.jsonc has values to carry, and the plain defaults
 * otherwise; both go through the same template, so a fresh install and a
 * migrated one end up with the same comments.
 */
export async function readClientSettingsFile(): Promise<string> {
  const existing = await read(CLIENT_SETTINGS_PATH);
  if (existing !== null) return existing;
  const seeded = clientSettingsTemplate(await inheritedValues());
  await seed(seeded);
  // Read back rather than returning what we wrote: if another launch won the
  // exclusive create, its bytes are the file and ours never existed.
  return (await read(CLIENT_SETTINGS_PATH)) ?? seeded;
}

// The values the client file starts life with: whatever the server's
// settings.jsonc says about the client's sections, or the defaults. Anything
// unreadable or unparseable yields the defaults — a settings file we cannot
// read is not evidence of a preference, and the alternative (refusing to seed)
// would leave the app with no client settings at all.
async function inheritedValues(): Promise<Settings> {
  const legacy = await read(SETTINGS_PATH);
  if (legacy === null) return DEFAULT_SETTINGS;
  try {
    // Parsed as if it were a client file, which is exactly the question being
    // asked of it: what did this install say about the client's sections?
    // Problems are dropped rather than warned — every server-owned section in
    // there is one, and they are not this file's business.
    const { settings } = parseSettings(JSON.parse(stripJsonc(legacy)), "client");
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// The save half, atomic like a note save (temp in the same dir, then rename)
// so a crash mid-save leaves the old file or the new one, never a truncated
// half. Not gated on parsing, for the same reason the server's is not: saving
// a mid-edit state the user means to come back to must not be refused.
export async function writeClientSettingsFile(text: string): Promise<void> {
  await ensureClientHome();
  const tmp = `${CLIENT_SETTINGS_PATH}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, CLIENT_SETTINGS_PATH);
}

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// "wx": exclusive create. The read above can fail for reasons other than
// absence (permissions, say), and clobbering an existing file we merely could
// not read would be data loss.
async function seed(text: string): Promise<void> {
  await ensureClientHome();
  await writeFile(CLIENT_SETTINGS_PATH, text, { encoding: "utf8", flag: "wx" }).catch(() => {});
}
