// The Bun end of profiles: named env files under PROFILES_DIR, injected at
// shell spawn into any note whose frontmatter names them (spawnParams.ts).
// This module owns the files: creation, and the read/write pair behind the
// view's in-app profile editor (architecture.md §6a).
//
// The editor is in-app because macOS binds no application to ".env": `open`
// fails with LSApplicationNotFound on a stock system. settings.jsonc opens
// in-app too, so every config file edits inside Ledge. The files stay plain
// dotenv on disk, greppable and hand-editable, and editor saves keep comments
// and untouched lines verbatim (shared/dotenv.ts), so a hand-edited file
// survives a dialog save.
import { join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isProfileName } from "../shared/frontmatter";
import { PROFILES_DIR } from "./spawnParams";

// Refuse any profile name that could steer the path. The name arrives from
// the view and becomes a filename, so it runs through isProfileName, the same
// check the frontmatter parser uses: letters, digits, "-" and "_" only.
// Separators and dots throw. Both the read and the write path call this first,
// and profiles.test.ts asserts the rejections.
export function assertProfileName(name: string): string {
  if (!isProfileName(name)) throw new Error(`not a profile name: ${name}`);
  return name;
}

// The header seeded into a new profile file. It shows the format on the first
// open and says why the folder sits outside the notes root. The seeded
// settings.jsonc documents its knobs the same way (settingsTemplate in
// shared/settings.ts).
function seedText(name: string): string {
  return [
    `# Ledge profile "${name}": KEY=value per line (# comments, export prefix ok).`,
    `# Injected into the shells of any note whose frontmatter says: profile: ${name}`,
    `# Secrets belong here, not in notes — this folder lives outside the notes`,
    `# root, so syncing or sharing your notes never carries it along.`,
    ``,
  ].join("\n");
}

/**
 * Create the profile's env file if it is missing, seeded and 0600 because it
 * holds secrets, and return its path. The "wx" flag is what refuses to
 * overwrite an existing file, as in the settings seed. The catch discards the
 * EEXIST that refusal raises, and every other create failure with it, so the
 * path still comes back and readProfile fails at its own read instead.
 */
export async function ensureProfileFile(name: string): Promise<string> {
  assertProfileName(name);
  await mkdir(PROFILES_DIR, { recursive: true, mode: 0o700 });
  const path = join(PROFILES_DIR, `${name}.env`);
  await writeFile(path, seedText(name), { encoding: "utf8", flag: "wx", mode: 0o600 }).catch(() => {});
  return path;
}

/** The profile's text for the editor dialog, seeding the file on first read. */
export async function readProfile(name: string): Promise<string> {
  return readFile(await ensureProfileFile(name), "utf8");
}

/**
 * Save the editor's serialized text back. Atomic like a note save (temp file
 * in the same directory, then rename): a crash mid-save leaves the old
 * secrets or the new, never half a file. The temp file is created 0600, so
 * the secrets are never readable by other users, not even for the moment
 * before the rename.
 */
export async function writeProfile(name: string, text: string): Promise<void> {
  assertProfileName(name);
  await mkdir(PROFILES_DIR, { recursive: true, mode: 0o700 });
  const path = join(PROFILES_DIR, `${name}.env`);
  const tmp = join(PROFILES_DIR, `.${name}.env.tmp-${process.pid}`);
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
