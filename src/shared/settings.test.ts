import { describe, expect, test } from "bun:test";
import {
  clientSettingsTemplate,
  DEFAULT_SETTINGS,
  homeOf,
  mergeSettings,
  parseSettings,
  SETTINGS_HOMES,
  settingsTemplate,
  type Settings,
  type SettingsHome,
} from "./settings";
import { stripJsonc } from "./jsonc";

// Every case names the home it is reading as, because that is now half the
// question: the same object parsed as the other file's is a list of sections
// that live somewhere else.
describe("parseSettings", () => {
  test.each(["server", "client"] as const)("an empty %s file yields the defaults, problem-free", (home) => {
    const { settings, problems } = parseSettings({}, home);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(problems).toEqual([]);
  });

  test("prompt fences are runnable out of the box, feeding claude on stdin", () => {
    // The trailing `<` is load-bearing (runner.test.ts explains); this pins
    // the default so an edit there cannot silently unmap agent blocks.
    expect(DEFAULT_SETTINGS.blocks.runnable).toContain("prompt");
    expect(DEFAULT_SETTINGS.blocks.interpreters["prompt"]).toBe("LEDGE_PROMPT_BLOCK=1 claude --allowedTools mcp__ledge -p <");
  });

  test("a full valid server file round-trips (interpreters merge over the defaults)", () => {
    const input = {
      shell: { path: "/opt/homebrew/bin/fish", args: ["-l"] },
      trash: { ttlDays: 7 },
      blocks: { runnable: ["sh", "python"], interpreters: { python: "/venv/bin/python" } },
    };
    const { settings, problems } = parseSettings(input, "server");
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      shell: input.shell,
      trash: input.trash,
      blocks: {
        runnable: ["sh", "python"],
        interpreters: { ...DEFAULT_SETTINGS.blocks.interpreters, python: "/venv/bin/python" },
        hostInterpreters: {},
      },
    });
    expect(problems).toEqual([]);
  });

  test("a full valid client file round-trips", () => {
    const input = {
      editor: { fontSize: 16, livePreview: false },
      terminal: { fontSize: 13 },
      appearance: { theme: "dark" },
    };
    const { settings, problems } = parseSettings(input, "client");
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, ...input, appearance: { theme: "dark" } });
    expect(problems).toEqual([]);
  });

  test("a partial file keeps defaults for everything unmentioned", () => {
    const { settings, problems } = parseSettings({ editor: { fontSize: 18 } }, "client");
    expect(settings.editor.fontSize).toBe(18);
    expect(settings.terminal).toEqual(DEFAULT_SETTINGS.terminal);
    expect(problems).toEqual([]);
  });

  test("a bad value costs only its own field", () => {
    const { settings, problems } = parseSettings(
      { editor: { fontSize: "big" }, terminal: { fontSize: 13 } },
      "client",
    );
    expect(settings.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
    expect(settings.terminal.fontSize).toBe(13); // the valid neighbor survives
    expect(problems).toEqual(['"editor.fontSize" must be a number between 6 and 72']);
  });

  test("out-of-range numbers are typos, not intent", () => {
    for (const fontSize of [0, -14, 500, NaN, Infinity]) {
      const { settings, problems } = parseSettings({ editor: { fontSize } }, "client");
      expect(settings.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
      expect(problems).toHaveLength(1);
    }
  });

  test("livePreview takes only booleans — a truthy string is a typo", () => {
    expect(parseSettings({ editor: { livePreview: false } }, "client").settings.editor.livePreview).toBe(false);
    const { settings, problems } = parseSettings({ editor: { livePreview: "yes" } }, "client");
    expect(settings.editor.livePreview).toBe(DEFAULT_SETTINGS.editor.livePreview);
    expect(problems).toEqual(['"editor.livePreview" must be true or false']);
  });

  test("appearance.theme takes the three spellings and nothing else", () => {
    for (const theme of ["system", "light", "dark"] as const) {
      const { settings, problems } = parseSettings({ appearance: { theme } }, "client");
      expect(settings.appearance.theme).toBe(theme);
      expect(problems).toEqual([]);
    }
    // Near-misses are typos, not intent — and the message names the whole set.
    const { settings, problems } = parseSettings({ appearance: { theme: "Dark" } }, "client");
    expect(settings.appearance.theme).toBe("system");
    expect(problems).toEqual(['"appearance.theme" must be one of "system", "light", "dark"']);
  });

  test("an absent appearance section means system, silently (seed-frozen files)", () => {
    // Every settings file seeded before the section existed lacks it; that is
    // the OS-following default, not a problem to report.
    const { settings, problems } = parseSettings({}, "client");
    expect(settings.appearance).toEqual({ theme: "system" });
    expect(problems).toEqual([]);
  });

  test("an empty shell path falls back rather than spawning nothing", () => {
    const { settings, problems } = parseSettings({ shell: { path: "" } }, "server");
    expect(settings.shell.path).toBe(DEFAULT_SETTINGS.shell.path);
    expect(problems).toEqual(['"shell.path" must be a non-empty string']);
  });

  test("shell args must all be strings", () => {
    const { settings, problems } = parseSettings({ shell: { args: ["-i", 3] } }, "server");
    expect(settings.shell.args).toEqual(DEFAULT_SETTINGS.shell.args);
    expect(problems).toEqual(['"shell.args" must be an array of strings']);
  });

  test("runnable languages are normalized to lowercase", () => {
    const { settings } = parseSettings({ blocks: { runnable: ["Python", "SH"] } }, "server");
    expect(settings.blocks.runnable).toEqual(["python", "sh"]);
  });

  test("overriding one interpreter does not un-map the rest", () => {
    const { settings, problems } = parseSettings(
      { blocks: { interpreters: { python: "/venv/bin/python", lua: "lua" } } },
      "server",
    );
    expect(settings.blocks.interpreters["python"]).toBe("/venv/bin/python");
    expect(settings.blocks.interpreters["lua"]).toBe("lua"); // user-added language
    expect(settings.blocks.interpreters["node"]).toBe(DEFAULT_SETTINGS.blocks.interpreters["node"]!);
    expect(problems).toEqual([]);
  });

  test("interpreter keys are normalized to lowercase, like runnable", () => {
    const { settings } = parseSettings({ blocks: { interpreters: { Python: "/venv/bin/python" } } }, "server");
    expect(settings.blocks.interpreters["python"]).toBe("/venv/bin/python");
  });

  test("a bad interpreter entry costs that language alone", () => {
    const { settings, problems } = parseSettings(
      { blocks: { interpreters: { python: "", ruby: "/opt/ruby" } } },
      "server",
    );
    expect(settings.blocks.interpreters["python"]).toBe(DEFAULT_SETTINGS.blocks.interpreters["python"]!);
    expect(settings.blocks.interpreters["ruby"]).toBe("/opt/ruby");
    expect(problems).toEqual(['"blocks.interpreters.python" must be a non-empty string']);
  });

  test("a non-object interpreters field is reported and defaults survive", () => {
    const { settings, problems } = parseSettings({ blocks: { interpreters: ["python3"] } }, "server");
    expect(settings.blocks.interpreters).toEqual(DEFAULT_SETTINGS.blocks.interpreters);
    expect(problems).toEqual(['"blocks.interpreters" must be an object of language -> command strings']);
  });

  test("hostInterpreters parses host patterns verbatim, languages lowercased", () => {
    const { settings, problems } = parseSettings(
      { blocks: { hostInterpreters: { "deploy@anypost-*": { Python: "/opt/py312/bin/python3" } } } },
      "server",
    );
    expect(settings.blocks.hostInterpreters).toEqual({
      "deploy@anypost-*": { python: "/opt/py312/bin/python3" },
    });
    expect(problems).toEqual([]);
  });

  test("a bad hostInterpreters entry costs that language of that host alone", () => {
    const { settings, problems } = parseSettings(
      { blocks: { hostInterpreters: { prod: { python: "", ts: "/opt/bun run" }, db: { python: "/opt/py" } } } },
      "server",
    );
    expect(settings.blocks.hostInterpreters["prod"]).toEqual({ ts: "/opt/bun run" });
    expect(settings.blocks.hostInterpreters["db"]).toEqual({ python: "/opt/py" });
    expect(problems).toEqual(['"blocks.hostInterpreters.prod.python" must be a non-empty string']);
  });

  test("a non-object host section costs that host alone; a non-object field costs the feature", () => {
    const one = parseSettings({ blocks: { hostInterpreters: { prod: "python3", db: { rb: "/opt/ruby" } } } }, "server");
    expect(one.settings.blocks.hostInterpreters["prod"]).toEqual({});
    expect(one.settings.blocks.hostInterpreters["db"]).toEqual({ rb: "/opt/ruby" });
    expect(one.problems.length).toBe(1);

    const all = parseSettings({ blocks: { hostInterpreters: ["prod"] } }, "server");
    expect(all.settings.blocks.hostInterpreters).toEqual({});
    expect(all.problems).toEqual([
      '"blocks.hostInterpreters" must be an object of host pattern -> language maps',
    ]);
  });

  test("hostInterpreters defaults to empty and stays optional", () => {
    const { settings, problems } = parseSettings({}, "server");
    expect(settings.blocks.hostInterpreters).toEqual({});
    expect(problems).toEqual([]);
  });

  test("a misspelled section is reported, not silently ignored", () => {
    const { settings, problems } = parseSettings({ editr: { fontSize: 18 } }, "server");
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(problems).toEqual(['unknown section "editr"']);
  });

  test("a non-object section is reported and its fields default", () => {
    const { settings, problems } = parseSettings({ editor: 18 }, "client");
    expect(settings.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
    expect(problems).toEqual(['"editor" is not an object']);
  });

  test("non-object roots (arrays, strings, null) yield defaults", () => {
    for (const raw of [null, "settings", [1, 2], 42]) {
      const { settings, problems } = parseSettings(raw, "server");
      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(problems).toEqual(["the settings file is not a JSON object"]);
    }
  });

  test("an absent daily section defaults silently (seed-frozen files)", () => {
    // Every settings file seeded before the section existed lacks it — that
    // must read as "unset", not as a problem.
    const { settings, problems } = parseSettings({}, "server");
    expect(settings.daily).toEqual({ workspace: "" });
    expect(problems).toEqual([]);
  });

  test("daily.workspace accepts strings, empty included; a non-string costs the field", () => {
    const good = parseSettings({ daily: { workspace: "~/notes/journal" } }, "server");
    expect(good.settings.daily).toEqual({ workspace: "~/notes/journal" });
    expect(good.problems).toEqual([]);

    const bad = parseSettings({ daily: { workspace: 3 } }, "server");
    expect(bad.settings.daily.workspace).toBe("");
    expect(bad.problems).toEqual(['"daily.workspace" must be a string']);
  });

  test("the retired daily.template field points at the template: daily marker", () => {
    const { settings, problems } = parseSettings({ daily: { workspace: "", template: "Daily Template" } }, "server");
    expect(settings.daily).toEqual({ workspace: "" });
    expect(problems).toEqual([
      '"daily.template" is retired — mark the note itself with `template: daily` frontmatter instead',
    ]);
  });

  test("the retired templates section points at the frontmatter marker", () => {
    // The section shipped briefly (a list of template note titles); a file
    // still carrying it gets the migration hint, not a bare unknown-section.
    const { problems } = parseSettings({ templates: { notes: ["Meeting"] } }, "server");
    expect(problems).toEqual(['"templates" is retired — mark a note with `template: true` frontmatter instead']);
  });
});

// The half of the split that a user actually meets: a settings.jsonc written
// before the boundary existed still has all seven sections in it, and the
// three that moved have to read as "ignored, and here is why" rather than as
// settings that quietly stopped working.
describe("a section in the wrong file", () => {
  test("the server's file reports the client's sections and does not read them", () => {
    const { settings, problems } = parseSettings(
      { shell: { path: "/bin/bash" }, editor: { fontSize: 22 }, appearance: { theme: "dark" } },
      "server",
    );
    expect(settings.shell.path).toBe("/bin/bash");
    // Not 22: the value here is inert, and the client's own file is what the
    // font size is read from.
    expect(settings.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
    expect(settings.appearance.theme).toBe("system");
    expect(problems).toEqual([
      '"editor" describes this screen, so it moved to this app\'s own settings; the copy here does nothing',
      '"appearance" describes this screen, so it moved to this app\'s own settings; the copy here does nothing',
    ]);
  });

  test("the client's file reports the server's sections the same way", () => {
    const { settings, problems } = parseSettings(
      { editor: { fontSize: 22 }, shell: { path: "/bin/bash" } },
      "client",
    );
    expect(settings.editor.fontSize).toBe(22);
    expect(settings.shell).toEqual(DEFAULT_SETTINGS.shell);
    expect(problems).toEqual([
      '"shell" describes the machine holding the notes, so it lives in that server\'s settings; the copy here does nothing',
    ]);
  });

  // A misplaced section is reported once, as a section. Validating its fields
  // too would bury the one message that matters under five that do not apply.
  test("a misplaced section's bad fields are not also reported", () => {
    const { problems } = parseSettings({ editor: { fontSize: "big", livePreview: "yes" } }, "server");
    expect(problems).toHaveLength(1);
  });
});

describe("the two homes", () => {
  // The compile-time half is `satisfies Record<keyof Settings, SettingsHome>`
  // on SETTINGS_HOMES itself: a section added without a home does not build.
  // This is the runtime half — that every section is claimed exactly once, and
  // that the merge takes each from the file that claims it.
  test("every section has a home", () => {
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      expect(["server", "client"]).toContain(homeOf(key));
    }
  });

  test("the merge takes each section from its owner", () => {
    const server: Settings = {
      ...DEFAULT_SETTINGS,
      shell: { path: "/bin/bash", args: [] },
      trash: { ttlDays: 3 },
      editor: { fontSize: 99, livePreview: false },
    };
    const client: Settings = {
      ...DEFAULT_SETTINGS,
      editor: { fontSize: 18, livePreview: false },
      appearance: { theme: "dark" },
      shell: { path: "/never/read", args: ["-x"] },
    };
    const merged = mergeSettings(server, client);
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      expect(merged[key]).toEqual((SETTINGS_HOMES[key] === "server" ? server : client)[key]);
    }
    // Spelled out, so the two lines that matter are readable without running
    // the loop above in your head.
    expect(merged.shell.path).toBe("/bin/bash");
    expect(merged.editor.fontSize).toBe(18);
  });
});

// The seeded files and the compiled defaults must be the same settings — a
// default edited in one place but not the other would ship a first launch that
// disagrees with itself.
describe("the seeded templates", () => {
  test.each([
    ["server", settingsTemplate(DEFAULT_SETTINGS.shell.path)],
    ["client", clientSettingsTemplate(DEFAULT_SETTINGS)],
  ] as Array<[SettingsHome, string]>)("the %s template strips to the defaults, problem-free", (home, template) => {
    const { settings, problems } = parseSettings(JSON.parse(stripJsonc(template)), home);
    expect(problems).toEqual([]);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  // Literally, not through a validator fallback: a template that omitted a
  // field would pass the test above on the default it was missing.
  test.each([
    ["server", settingsTemplate(DEFAULT_SETTINGS.shell.path)],
    ["client", clientSettingsTemplate(DEFAULT_SETTINGS)],
  ] as Array<[SettingsHome, string]>)("the %s template names exactly its own sections", (home, template) => {
    const raw = JSON.parse(stripJsonc(template)) as Record<string, unknown>;
    const mine = (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>).filter((k) => SETTINGS_HOMES[k] === home);
    expect(Object.keys(raw).sort()).toEqual([...mine].sort());
    for (const key of mine) expect(raw[key]).toEqual(DEFAULT_SETTINGS[key]);
  });

  // The client template is generated because it has a second job: carrying an
  // existing install's values across when the split happens. If it did not
  // substitute them, everyone's font size would silently reset on upgrade.
  test("the client template carries the values it is given, comments intact", () => {
    const text = clientSettingsTemplate({
      ...DEFAULT_SETTINGS,
      editor: { fontSize: 17, livePreview: false },
      terminal: { fontSize: 11 },
      appearance: { theme: "dark" },
    });
    const { settings, problems } = parseSettings(JSON.parse(stripJsonc(text)), "client");
    expect(problems).toEqual([]);
    expect(settings.editor).toEqual({ fontSize: 17, livePreview: false });
    expect(settings.terminal).toEqual({ fontSize: 11 });
    expect(settings.appearance).toEqual({ theme: "dark" });
    expect(text).toContain("// Conceal markdown syntax away from the caret");
  });
});
