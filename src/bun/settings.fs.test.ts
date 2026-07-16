// loadSettings against a real filesystem: the first-launch seed, the
// merge-with-defaults on a partial file, and — most important — the promise
// that a broken file is never rewritten. Root and guard match
// notes.fs.test.ts (scratch root via src/test-preload.ts; see bunfig.toml).
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { NOTES_ROOT } from "./notes";
import { loadSettings, SETTINGS_PATH } from "./settings";

if (!resolve(NOTES_ROOT).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${NOTES_ROOT} — is the preload configured?`);
}

beforeEach(async () => {
  await rm(NOTES_ROOT, { recursive: true, force: true });
  await mkdir(NOTES_ROOT, { recursive: true });
});

describe("loadSettings", () => {
  test("first launch: returns defaults and seeds a file that documents them all", async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    // The seeded file spells out every knob and parses back to the defaults.
    expect(JSON.parse(await readFile(SETTINGS_PATH, "utf8"))).toEqual(DEFAULT_SETTINGS);
  });

  test("a valid file wins over the defaults", async () => {
    await writeFile(SETTINGS_PATH, JSON.stringify({ editor: { fontSize: 18 }, trash: { ttlDays: 7 } }));
    const s = await loadSettings();
    expect(s.editor.fontSize).toBe(18);
    expect(s.trash.ttlDays).toBe(7);
    expect(s.shell).toEqual(DEFAULT_SETTINGS.shell); // unmentioned → default
  });

  test("unparseable JSON runs on defaults and leaves the file untouched", async () => {
    const broken = '{ "editor": { "fontSize": 18, } }'; // trailing comma
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
});
