// loadSettings against a real filesystem: the first-launch seed, the JSONC
// tolerance, the settings.json -> settings.jsonc migration, and — most
// important — the promise that a broken file is never rewritten. Home and
// guard match notes.fs.test.ts (scratch app home via src/test-preload.ts; see
// bunfig.toml).
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { DEFAULT_SETTINGS, SETTINGS_TEMPLATE } from "../shared/settings";
import { APP_HOME } from "./workspaces";
import { LEGACY_SETTINGS_PATH, loadSettings, readSettingsFile, SETTINGS_PATH, writeSettingsFile } from "./settings";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

const exists = (path: string) =>
  readFile(path, "utf8").then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
});

describe("loadSettings", () => {
  test("first launch: returns defaults and seeds the commented template", async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    // The seeded file is the template verbatim — the knobs documented in
    // comments — and the template ↔ defaults agreement is pinned in
    // shared/settings.test.ts.
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(SETTINGS_TEMPLATE);
  });

  test("a valid file wins over the defaults, comments and trailing commas welcome", async () => {
    await writeFile(
      SETTINGS_PATH,
      `{
        // bigger type
        "editor": { "fontSize": 18 }, /* and a fast trash */
        "trash": { "ttlDays": 7, },
      }`,
    );
    const s = await loadSettings();
    expect(s.editor.fontSize).toBe(18);
    expect(s.trash.ttlDays).toBe(7);
    expect(s.shell).toEqual(DEFAULT_SETTINGS.shell); // unmentioned → default
  });

  test("unparseable JSONC runs on defaults and leaves the file untouched", async () => {
    const broken = '{ "editor": { "fontSize": } }';
    await writeFile(SETTINGS_PATH, broken);
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    // Byte-for-byte: the file is the user's, mid-edit; fixing it is theirs to do.
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(broken);
  });

  test("a bad value falls back alone, and the file is not rewritten", async () => {
    const text = JSON.stringify({ editor: { fontSize: "big" }, terminal: { fontSize: 13 } });
    await writeFile(SETTINGS_PATH, text);
    const s = await loadSettings();
    expect(s.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
    expect(s.terminal.fontSize).toBe(13);
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(text);
  });

  test("a legacy settings.json is renamed to settings.jsonc, bytes intact", async () => {
    const text = JSON.stringify({ terminal: { fontSize: 13 } });
    await writeFile(LEGACY_SETTINGS_PATH, text);
    const s = await loadSettings();
    expect(s.terminal.fontSize).toBe(13);
    // Rename, not copy: one file remains, at the new name, byte-for-byte.
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(text);
    expect(await exists(LEGACY_SETTINGS_PATH)).toBe(false);
  });

  test("an existing settings.jsonc wins over a lingering settings.json", async () => {
    await writeFile(SETTINGS_PATH, '{ "terminal": { "fontSize": 13 } }');
    await writeFile(LEGACY_SETTINGS_PATH, '{ "terminal": { "fontSize": 9 } }');
    const s = await loadSettings();
    expect(s.terminal.fontSize).toBe(13);
    // The legacy file is left alone — never merged, never deleted.
    expect(await exists(LEGACY_SETTINGS_PATH)).toBe(true);
  });
});

describe("readSettingsFile / writeSettingsFile", () => {
  test("first read seeds and returns the template — ⌘, on a fresh install opens documented knobs", async () => {
    expect(await readSettingsFile()).toBe(SETTINGS_TEMPLATE);
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(SETTINGS_TEMPLATE);
  });

  test("write persists exactly the given text; the next read returns it", async () => {
    const text = '{\n  // mine\n  "editor": { "fontSize": 17 }\n}\n';
    await writeSettingsFile(text);
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(text);
    expect(await readSettingsFile()).toBe(text);
    expect((await loadSettings()).editor.fontSize).toBe(17);
  });

  test("read migrates a legacy file just like loadSettings does", async () => {
    const text = '{ "trash": { "ttlDays": 3 } }';
    await writeFile(LEGACY_SETTINGS_PATH, text);
    expect(await readSettingsFile()).toBe(text);
    expect(await exists(LEGACY_SETTINGS_PATH)).toBe(false);
  });
});
