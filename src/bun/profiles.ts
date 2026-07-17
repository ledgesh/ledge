// The Bun end of profiles: named env files under PROFILES_DIR, injected at
// shell spawn into any note whose frontmatter names them (spawnParams.ts).
// This module owns the files: creation, and the read/write pair behind the
// view's profile editor.
//
// Profiles do NOT go through the OS editor the way settings.json does: macOS
// binds no application to ".env" (`open` fails with LSApplicationNotFound on
// a stock system), so Ledge's own editor dialog is the UI. The file stays a
// plain dotenv on disk — greppable, hand-editable, and the editor's saves
// preserve comments (shared/dotenv.ts) — so hand edits and dialog edits
// coexist rather than compete.
import { join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isProfileName } from "../shared/frontmatter";
import { PROFILES_DIR } from "./spawnParams";

// The whole trust story for profileOpen: the name arrives from the view and
// becomes a filename, so it is checked with the same predicate the parser
// used — anything else (separators, dots) must throw, and there is a test
// saying so.
export function assertProfileName(name: string): string {
  if (!isProfileName(name)) throw new Error(`not a profile name: ${name}`);
  return name;
}

// Seeded so the very first open documents its own format and its reason for
// existing, the way the seeded settings.json documents its knobs.
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
 * Make sure a profile's env file exists — created seeded and 0600 (it will
 * hold secrets) — and return its path. The create is exclusive ("wx"), same
 * as the settings seed: an existing file is never rewritten, whatever the
 * reason it could not be created.
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
 * in the same dir, then rename) so a crash mid-save leaves the old secrets or
 * the new, never half a file — and the temp carries 0600 from birth, so the
 * secrets are never readable through a fresh file's default mode even for a
 * moment.
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
