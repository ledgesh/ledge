// loadSettings against a real filesystem: the first-launch seed, the JSONC
// tolerance, the settings.json to settings.jsonc migration, and the rule that
// a broken file is never rewritten. The app home is a scratch temp dir, set by
// src/test-preload.ts (see bunfig.toml). The guard below re-checks that, the
// same way notes.fs.test.ts does.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { DEFAULT_SETTINGS, settingsTemplate } from "../shared/settings";
import { APP_HOME } from "./workspaces";
import {
  inspectSettings,
  LEGACY_SETTINGS_PATH,
  loadSettings,
  readSettingsFile,
  seededShellPath,
  SETTINGS_PATH,
  writeSettingsFile,
} from "./settings";

// What the seed writes on this machine. The shell path in it is resolved per
// machine (bun/spawnParams.ts), so these tests name it the way the seed does.
// spawnParams.test.ts covers the resolution ladder itself, with an
// `installed` predicate standing in for the machine.
const SEEDED_TEMPLATE = settingsTemplate(seededShellPath());

// The defaults as this machine gets them. Only the shell differs: everything
// else in DEFAULT_SETTINGS is portable, and that one field is resolved against
// the filesystem so a Linux box is not handed a macOS path.
const SEEDED_DEFAULTS = {
  ...DEFAULT_SETTINGS,
  shell: { ...DEFAULT_SETTINGS.shell, path: seededShellPath() },
};

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
    expect(await loadSettings()).toEqual(SEEDED_DEFAULTS);
    // The seeded file is the template verbatim, comments and all. The
    // comments are the knob documentation. shared/settings.test.ts pins that
    // the template and DEFAULT_SETTINGS agree.
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(SEEDED_TEMPLATE);
  });

  // The bug this seam exists for: a settings.jsonc with no shell section used
  // to hand a Linux server the macOS literal in DEFAULT_SETTINGS. The pty
  // forked a child that died at execve, so the block ended with no output, no
  // error and no exit code.
  test("a file that names no shell gets this machine's, not the portable literal", async () => {
    await writeFile(SETTINGS_PATH, '{ "trash": { "ttlDays": 7 } }');
    const s = await loadSettings();
    expect(s.shell.path).toBe(seededShellPath());
    expect(s.trash.ttlDays).toBe(7);
  });

  // The other side of that: a path the user wrote stays theirs. The file is
  // the settings UI (architecture.md §6). Substituting one that works would
  // leave it showing a shell other than the one that spawned.
  test("a shell the user named is kept even when this machine cannot run it", async () => {
    await writeFile(SETTINGS_PATH, JSON.stringify({ shell: { path: "/bin/nope" } }));
    expect((await loadSettings()).shell.path).toBe("/bin/nope");
  });

  test("a valid file wins over the defaults, comments and trailing commas welcome", async () => {
    await writeFile(
      SETTINGS_PATH,
      `{
        // my shell
        "shell": { "path": "/bin/bash" }, /* and a fast trash */
        "trash": { "ttlDays": 7, },
      }`,
    );
    const s = await loadSettings();
    expect(s.shell.path).toBe("/bin/bash");
    expect(s.trash.ttlDays).toBe(7);
    expect(s.blocks).toEqual(DEFAULT_SETTINGS.blocks); // unmentioned → default
  });

  test("unparseable JSONC runs on defaults and leaves the file untouched", async () => {
    const broken = '{ "editor": { "fontSize": } }';
    await writeFile(SETTINGS_PATH, broken);
    expect(await loadSettings()).toEqual(SEEDED_DEFAULTS);
    // Byte-for-byte: the file is the user's, mid-edit. loadSettings does not
    // repair it.
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(broken);
  });

  test("a bad value falls back alone, and the file is not rewritten", async () => {
    const text = JSON.stringify({ trash: { ttlDays: "soon" }, shell: { path: "/bin/bash" } });
    await writeFile(SETTINGS_PATH, text);
    const s = await loadSettings();
    expect(s.trash.ttlDays).toBe(DEFAULT_SETTINGS.trash.ttlDays);
    expect(s.shell.path).toBe("/bin/bash");
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(text);
  });

  // The server side of the settings split (remote.md §5). An install written
  // before the boundary existed still carries the client's sections. The
  // server reports those sections as problems. It does not apply them: a font
  // size set on a server changes nothing anyone can see.
  test("a client section left behind by the split is reported, not applied", async () => {
    await writeFile(SETTINGS_PATH, JSON.stringify({ editor: { fontSize: 18 }, trash: { ttlDays: 7 } }));
    const s = await loadSettings();
    expect(s.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
    expect(s.trash.ttlDays).toBe(7);
    expect((await inspectSettings()).problems).toEqual([
      '"editor" describes this screen, so it moved to this app\'s own settings; the copy here does nothing',
    ]);
  });

  test("a legacy settings.json is renamed to settings.jsonc, bytes intact", async () => {
    const text = JSON.stringify({ trash: { ttlDays: 13 } });
    await writeFile(LEGACY_SETTINGS_PATH, text);
    const s = await loadSettings();
    expect(s.trash.ttlDays).toBe(13);
    // Rename, not copy: one file remains, at the new name, byte-for-byte.
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(text);
    expect(await exists(LEGACY_SETTINGS_PATH)).toBe(false);
  });

  test("an existing settings.jsonc wins over a lingering settings.json", async () => {
    await writeFile(SETTINGS_PATH, '{ "trash": { "ttlDays": 13 } }');
    await writeFile(LEGACY_SETTINGS_PATH, '{ "trash": { "ttlDays": 9 } }');
    const s = await loadSettings();
    expect(s.trash.ttlDays).toBe(13);
    // The legacy file is left alone: never merged, never deleted.
    expect(await exists(LEGACY_SETTINGS_PATH)).toBe(true);
  });
});

describe("readSettingsFile / writeSettingsFile", () => {
  test("first read seeds and returns the template — ⌘, on a fresh install opens documented knobs", async () => {
    expect(await readSettingsFile()).toBe(SEEDED_TEMPLATE);
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(SEEDED_TEMPLATE);
  });

  test("write persists exactly the given text; the next read returns it", async () => {
    const text = '{\n  // mine\n  "trash": { "ttlDays": 17 }\n}\n';
    await writeSettingsFile(text);
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(text);
    expect(await readSettingsFile()).toBe(text);
    expect((await loadSettings()).trash.ttlDays).toBe(17);
  });

  test("read migrates a legacy file just like loadSettings does", async () => {
    const text = '{ "trash": { "ttlDays": 3 } }';
    await writeFile(LEGACY_SETTINGS_PATH, text);
    expect(await readSettingsFile()).toBe(text);
    expect(await exists(LEGACY_SETTINGS_PATH)).toBe(false);
  });
});

// What the MCP `settings` tool hands an agent. One call answers both halves of
// a settings question: what the user has set (their text), and what the knobs
// are (the template's comments, which the text still carries on an unmodified
// install).
describe("inspectSettings", () => {
  test("returns the raw text with its comments intact, plus the path", async () => {
    const text = '{\n  // my venv\n  "blocks": { "interpreters": { "python": "~/.venvs/app/bin/python" } }\n}\n';
    await writeFile(SETTINGS_PATH, text);
    const seen = await inspectSettings();
    expect(seen.text).toBe(text);
    expect(seen.path).toBe(SETTINGS_PATH);
    // Comments survive the read. An agent advising on a knob needs the
    // documentation that lives in them.
    expect(seen.text).toContain("// my venv");
    expect(seen.problems).toEqual([]);
  });

  test("a fresh install reads as the documented template", async () => {
    // The seeded template documents every knob, so an agent asked about one
    // on an install nobody has customized still gets that knob's comment.
    expect((await inspectSettings()).text).toBe(SEEDED_TEMPLATE);
  });

  test("a bad value is reported, not corrected", async () => {
    const text = JSON.stringify({ trash: { ttlDays: "big" } });
    await writeFile(SETTINGS_PATH, text);
    const seen = await inspectSettings();
    expect(seen.problems.length).toBe(1);
    expect(seen.problems[0]).toContain("ttlDays");
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(text);
  });

  test("unparseable JSONC is one problem naming the launch consequence, bytes untouched", async () => {
    const broken = '{ "editor": { "fontSize": } }';
    await writeFile(SETTINGS_PATH, broken);
    const seen = await inspectSettings();
    expect(seen.problems.length).toBe(1);
    expect(seen.problems[0]).toContain("entirely on defaults");
    // The agent still gets the text. Reading a file the user is mid-edit on
    // is how it can tell them which line broke.
    expect(seen.text).toBe(broken);
    expect(await readFile(SETTINGS_PATH, "utf8")).toBe(broken);
  });
});
