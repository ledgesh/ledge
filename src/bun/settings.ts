// The server's half of settings: settings.jsonc in the app home (~/.ledge),
// beside the workspace registry and the managed workspace folders. Its
// sections describe this machine: the shell to spawn, how long the trash keeps
// things, what a code fence runs, where daily notes go. Font sizes and the
// theme are the client's, in bun/clientSettings.ts (remote.md §5).
//
// This module is the only thing that writes the file. bun/clientSettings.ts
// also reads it, to seed its own file from an older install's client sections.
// Settings are global rather than per-workspace: a shell path or an interpreter
// map is a fact about a machine, not about a folder. The app reads the file at
// launch, so an edit applies at the next launch, never live; restart-applies is
// the policy, not a limitation to fix (architecture.md §6). The MCP server is a
// separate process and reads per tool call (bun/mcpTools.ts).
import { join } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, parseSettings, settingsTemplate, type Settings } from "../shared/settings";
import { stripJsonc } from "../shared/jsonc";
import { defaultShellPath, isExecutableFile, shellCaveat, shellRefusal } from "./spawnParams";
import { APP_HOME, ensureAppHome } from "./workspaces";

export const SETTINGS_PATH = join(APP_HOME, "settings.jsonc");
// The pre-JSONC spelling, kept only for the one-time migration rename.
export const LEGACY_SETTINGS_PATH = join(APP_HOME, "settings.json");

// Read and validate settings.jsonc, warning about the shell it names.
// No file: write the commented template. The file is the settings UI, so it
// should document every knob. Unparseable JSONC: warn, run on defaults, and
// leave the bytes alone. They may be a file the user is mid-edit on. A bad
// value: it falls back on its own, reported by parseSettings.
export async function loadSettings(): Promise<Settings> {
  const settings = await readSettings();
  warnAboutShell(settings.shell.path);
  return settings;
}

async function readSettings(): Promise<Settings> {
  const raw = await readSettingsText();
  if (raw === null) {
    await seedDefaultFile();
    return withDefaultShell(DEFAULT_SETTINGS);
  }
  let json: unknown;
  try {
    json = JSON.parse(stripJsonc(raw));
  } catch (err) {
    console.warn(`[settings] ${SETTINGS_PATH} is not valid JSONC (${err}); running on defaults`);
    return withDefaultShell(DEFAULT_SETTINGS);
  }
  const { settings, problems } = parseSettings(json, "server");
  for (const p of problems) console.warn(`[settings] ${p}; using the default`);
  return namesShellPath(json) ? settings : withDefaultShell(settings);
}

// The shell to seed when the file does not name one: this account's login
// shell if Ledge supports it, otherwise the first supported shell installed
// (bun/spawnParams.ts). DEFAULT_SETTINGS.shell.path is the last resort, for a
// machine with no supported shell at all. It can only be a macOS literal,
// which names nothing on Linux, because shared/ may not reach for anything
// only Bun has (shared/portable.test.ts; architecture.md §6, "A default that
// cannot be a constant"). Seeding it still writes a concrete path into
// settings.jsonc, and bun/server.ts refuses the spawn with a message rather
// than forking a pty whose child dies at execve, leaving the block with no
// output, no error and no exit code.
export function seededShellPath(): string {
  return defaultShellPath() ?? DEFAULT_SETTINGS.shell.path;
}

function withDefaultShell(settings: Settings): Settings {
  return { ...settings, shell: { ...settings.shell, path: seededShellPath() } };
}

// Whether the file names a shell itself. A shell the user wrote is never
// substituted, even when this machine cannot run it: warnAboutShell below
// warns about it instead. Substituting silently is the worse of the two
// failures, since the file is the settings UI and would then show one shell
// while the pty spawned another.
function namesShellPath(json: unknown): boolean {
  const shell = (json as { shell?: { path?: unknown } } | null | undefined)?.shell;
  return typeof shell?.path === "string" && shell.path.length > 0;
}

// Warn about the configured shell once at launch, which on a server is the
// first thing in logs/ledge-server.log. Without the warning the user meets the
// problem at the first Run instead: a shell that cannot spawn refuses the
// block (bun/server.ts), and an unsupported one runs it without reporting its
// output or its exit code.
function warnAboutShell(path: string): void {
  const refusal = shellRefusal(path, isExecutableFile);
  if (refusal) {
    console.warn(`[settings] ${refusal}; no shell can start until that is fixed`);
    return;
  }
  const caveat = shellCaveat(path);
  if (caveat) console.warn(`[settings] ${caveat}`);
}

// The file's text, migrating a legacy settings.json into place when that is
// what exists. Null when there is nothing to read.
async function readSettingsText(): Promise<string | null> {
  let jsoncMissing = false;
  try {
    return await readFile(SETTINGS_PATH, "utf8");
  } catch (err) {
    jsoncMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  // Migrate only into a confirmed absence. rename clobbers its target, and a
  // failed read is not proof of absence (permissions, say), so a settings.jsonc
  // that exists but could not be read must not be overwritten by the legacy
  // file. JSON is valid JSONC, so the migrated bytes are already right.
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
// absence (permissions, say), and overwriting a file that exists but could not
// be read would lose data. If the file exists, whatever the reason the read
// failed, it stays as it is.
async function seedDefaultFile(): Promise<void> {
  await ensureAppHome();
  await writeFile(SETTINGS_PATH, settingsTemplate(seededShellPath()), { encoding: "utf8", flag: "wx" }).catch(() => {});
}

// The settings editor's load half (settingsRead): the raw text. On a first
// launch, or the first time ⌘, opens the file, this seeds the commented
// template, so the editor opens on a file that documents every knob rather
// than on an empty pane.
export async function readSettingsFile(): Promise<string> {
  const raw = await readSettingsText();
  if (raw !== null) return raw;
  await seedDefaultFile();
  try {
    return await readFile(SETTINGS_PATH, "utf8");
  } catch {
    // Unreadable even after seeding (permissions): the editor still opens on
    // the template. A save may fail, but viewing the knobs still works.
    return settingsTemplate(seededShellPath());
  }
}

// What an agent may learn about settings (the MCP `settings` tool): the file's
// raw text, its path, and the problems launch would report. The text keeps its
// comments, which are the knob documentation (settingsTemplate), so on an
// unmodified install one read returns both what the user configured and what
// every knob means. It reads through readSettingsFile, like the ⌘, editor, so
// a first read seeds the template the next launch would have written anyway.
//
// Read-only, with no writing sibling, and it should not grow one
// (architecture.md §1): the prompt-fence default pre-authorizes this server's
// whole tool namespace, and settings name the shell and the interpreter the
// user's next run uses. Reading is allowed because the file is the user's
// config rather than a secret store, and any shell the agent already has can
// read it. A value can still hold a connection string someone inlined instead
// of using a profile.
export async function inspectSettings(): Promise<{ path: string; text: string; problems: string[] }> {
  const text = await readSettingsFile();
  let json: unknown;
  try {
    json = JSON.parse(stripJsonc(text));
  } catch (err) {
    // The launch-time answer, reported rather than repaired: an unparseable
    // file means launch runs entirely on defaults, and the bytes stay as the
    // user left them.
    return { path: SETTINGS_PATH, text, problems: [`not valid JSONC (${err}); Ledge would run entirely on defaults`] };
  }
  return { path: SETTINGS_PATH, text, problems: parseSettings(json, "server").problems };
}

// The save half (settingsWrite): the dialog sends the full new text, written
// atomically like a note save (temp file beside it, then rename), so a crash
// mid-save leaves the old file or the new one, never a truncated half. Parsing
// does not gate the write: the file is the user's, and a mid-edit save is never
// refused. The dialog shows problems live, and launch falls back per field.
export async function writeSettingsFile(text: string): Promise<void> {
  await ensureAppHome();
  const tmp = SETTINGS_PATH + ".tmp";
  await writeFile(tmp, text, "utf8");
  await rename(tmp, SETTINGS_PATH);
}
