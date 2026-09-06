// Filesystem tests for the client's settings file and the one-time split
// (remote.md §5). shared/settings.test.ts covers the validator. An install that
// predates the split keeps its font size. Carrying those values across leaves
// the file they came from untouched. The app home is a scratch temp dir set by
// src/test-preload.ts, and the guard below re-checks it, the same way
// settings.fs.test.ts does.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { clientSettingsTemplate, DEFAULT_SETTINGS } from "../shared/settings";
import { APP_HOME } from "./workspaces";
import { SETTINGS_PATH } from "./settings";
import {
  CLIENT_SETTINGS_PATH,
  loadClientSettings,
  readClientSettingsFile,
  writeClientSettingsFile,
} from "./clientSettings";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
});

describe("a fresh install", () => {
  test("seeds the commented template and runs on the defaults", async () => {
    expect(await loadClientSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await readFile(CLIENT_SETTINGS_PATH, "utf8")).toBe(clientSettingsTemplate(DEFAULT_SETTINGS));
  });

  test("the first ⌘, on the client tab opens documented knobs, not an empty pane", async () => {
    const text = await readClientSettingsFile();
    expect(text).toContain("// Conceal markdown syntax away from the caret");
    expect(text).toContain('"fontSize"');
  });
});

// The upgrade path. A settings.jsonc written before the split holds all seven
// sections. The client's three (editor, terminal, appearance) are lifted out
// of it once, so values already set there are kept rather than reset to the
// defaults.
describe("the split", () => {
  test("carries the client's values out of an older settings.jsonc", async () => {
    await writeFile(
      SETTINGS_PATH,
      `{
        "shell": { "path": "/bin/bash" },
        "editor": { "fontSize": 19, "livePreview": false },
        "terminal": { "fontSize": 11 },
        "appearance": { "theme": "dark" }
      }`,
    );
    const s = await loadClientSettings();
    expect(s.editor).toEqual({ fontSize: 19, livePreview: false });
    expect(s.terminal).toEqual({ fontSize: 11 });
    expect(s.appearance).toEqual({ theme: "dark" });
  });

  test("leaves the file it read byte-for-byte alone", async () => {
    const before = '{ "editor": { "fontSize": 19 }, "shell": { "path": "/bin/bash" } }';
    await writeFile(SETTINGS_PATH, before);
    await loadClientSettings();
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(before);
  });

  // Only the client's sections move. A client file that inherited "shell"
  // would be a second, silent answer to which shell runs.
  test("takes only the client's sections", async () => {
    await writeFile(SETTINGS_PATH, '{ "shell": { "path": "/bin/bash" }, "editor": { "fontSize": 19 } }');
    await loadClientSettings();
    const seeded = await readFile(CLIENT_SETTINGS_PATH, "utf8");
    expect(seeded).toContain("19");
    expect(seeded).not.toContain("/bin/bash");
  });

  test("happens once: a later edit to the server's file does not reach back", async () => {
    await writeFile(SETTINGS_PATH, '{ "editor": { "fontSize": 19 } }');
    expect((await loadClientSettings()).editor.fontSize).toBe(19);
    await writeFile(SETTINGS_PATH, '{ "editor": { "fontSize": 30 } }');
    expect((await loadClientSettings()).editor.fontSize).toBe(19);
  });

  test("an unreadable older file costs the defaults, not the launch", async () => {
    await writeFile(SETTINGS_PATH, "{ half a wri");
    expect((await loadClientSettings()).editor).toEqual(DEFAULT_SETTINGS.editor);
  });
});

describe("reading and writing", () => {
  test("write persists exactly the given text; the next read returns it", async () => {
    const text = '{\n  // mine\n  "editor": { "fontSize": 17 }\n}\n';
    await writeClientSettingsFile(text);
    expect(await readFile(CLIENT_SETTINGS_PATH, "utf8")).toBe(text);
    expect(await readClientSettingsFile()).toBe(text);
    expect((await loadClientSettings()).editor.fontSize).toBe(17);
  });

  test("unparseable JSONC runs on defaults and leaves the file untouched", async () => {
    const broken = '{ "editor": { "fontSize": } }';
    await writeClientSettingsFile(broken);
    expect(await loadClientSettings()).toEqual(DEFAULT_SETTINGS);
    // The file is the user's and may be mid-edit. Ledge does not repair or
    // rewrite it. Fixing it is the user's to do (loadClientSettings in
    // clientSettings.ts).
    expect(await readFile(CLIENT_SETTINGS_PATH, "utf8")).toBe(broken);
  });

  test("a leftover server section is reported rather than obeyed", async () => {
    await writeClientSettingsFile('{ "shell": { "path": "/bin/bash" }, "editor": { "fontSize": 17 } }');
    const s = await loadClientSettings();
    expect(s.shell).toEqual(DEFAULT_SETTINGS.shell);
    expect(s.editor.fontSize).toBe(17);
  });
});
