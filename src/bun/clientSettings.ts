// The client's half of settings: font sizes, the theme, live preview.
//
// bun/settings.ts is the server-side sibling, and the two are near-identical:
// same JSONC, same commented template seeded on first read, same atomic save,
// same restart-applies policy. What differs is whose fact the file holds
// (shared/settings.ts SETTINGS_HOMES) and where it lives. This one lives in
// the client home, so it stays with the app when the app connects to another
// machine's notes (remote.md §5).
//
// This module also does the one-time split. An install from before the
// boundary existed has all seven sections in the server's settings.jsonc. The
// first launch after the upgrade copies the client-owned values into a file of
// their own, so a configured font size does not go back to the default. The
// server's copy is left byte-for-byte alone: it is the user's file, and
// rewriting someone's commented config to delete four lines is not a
// migration's business. parseSettings warns that the copies left behind are
// ignored. Nothing removes them, so they sit in the file until the user
// deletes them.
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
 * Read and validate the client's settings. Three shapes of trouble get the
 * same three answers as the server's file. No file yet: seed one, doing the
 * split first if there is anything to split. Unparseable: warn and run on
 * defaults, leaving the bytes untouched, since it is the user's file mid-edit.
 * A bad value: that field falls back on its own.
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
 * The file's raw text, seeding it when there is none. The seed is the split:
 * the client values from an older settings.jsonc when it has any, the plain
 * defaults otherwise. Both go through the same template, so a fresh install
 * and a migrated one end up with the same comments.
 */
export async function readClientSettingsFile(): Promise<string> {
  const existing = await read(CLIENT_SETTINGS_PATH);
  if (existing !== null) return existing;
  const seeded = clientSettingsTemplate(await inheritedValues());
  await seed(seeded);
  // Read back rather than returning the seeded text: if another launch won
  // the exclusive create in `seed`, that launch's bytes are the file.
  return (await read(CLIENT_SETTINGS_PATH)) ?? seeded;
}

// The values the client file starts with: what the server's settings.jsonc
// says about the client's sections, or the defaults. A file that cannot be
// read or parsed yields the defaults rather than blocking the seed. A
// settings file that cannot be read is no evidence of a preference, and
// refusing to seed would leave the app with no client settings file at all.
async function inheritedValues(): Promise<Settings> {
  const legacy = await read(SETTINGS_PATH);
  if (legacy === null) return DEFAULT_SETTINGS;
  try {
    // Parsed with home "client", which is what this needs to know: what does
    // this install say about the client's sections? The problems are dropped
    // rather than warned. Every server-owned section in the file produces
    // one, and those sections are not this file's business.
    const { settings } = parseSettings(JSON.parse(stripJsonc(legacy)), "client");
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// The save half, atomic like a note save (temp in the same dir, then rename),
// so a crash mid-save leaves the old file or the new one and never a
// truncated half. The write happens whether or not the text parses, like the
// server's save in bun/settings.ts. Saving a mid-edit state the user means to
// come back to must not be refused.
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
// absence (permissions, say), and clobbering an existing file that was merely
// unreadable would be data loss.
async function seed(text: string): Promise<void> {
  await ensureClientHome();
  await writeFile(CLIENT_SETTINGS_PATH, text, { encoding: "utf8", flag: "wx" }).catch(() => {});
}
