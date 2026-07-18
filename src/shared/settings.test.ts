import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, parseSettings } from "./settings";

describe("parseSettings", () => {
  test("an empty object yields the defaults, problem-free", () => {
    const { settings, problems } = parseSettings({});
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(problems).toEqual([]);
  });

  test("prompt fences are runnable out of the box, feeding claude on stdin", () => {
    // The trailing `<` is load-bearing (runner.test.ts explains); this pins
    // the default so an edit there cannot silently unmap agent blocks.
    expect(DEFAULT_SETTINGS.blocks.runnable).toContain("prompt");
    expect(DEFAULT_SETTINGS.blocks.interpreters["prompt"]).toBe("LEDGE_PROMPT_BLOCK=1 claude --allowedTools mcp__ledge -p <");
  });

  test("a full valid file round-trips (interpreters merge over the defaults)", () => {
    const input = {
      shell: { path: "/opt/homebrew/bin/fish", args: ["-l"] },
      editor: { fontSize: 16, livePreview: false },
      terminal: { fontSize: 13 },
      trash: { ttlDays: 7 },
      blocks: { runnable: ["sh", "python"], interpreters: { python: "/venv/bin/python" } },
    };
    const { settings, problems } = parseSettings(input);
    expect(settings).toEqual({
      ...input,
      blocks: {
        runnable: ["sh", "python"],
        interpreters: { ...DEFAULT_SETTINGS.blocks.interpreters, python: "/venv/bin/python" },
        hostInterpreters: {},
      },
    });
    expect(problems).toEqual([]);
  });

  test("a partial file keeps defaults for everything unmentioned", () => {
    const { settings, problems } = parseSettings({ editor: { fontSize: 18 } });
    expect(settings.editor.fontSize).toBe(18);
    expect(settings.shell).toEqual(DEFAULT_SETTINGS.shell);
    expect(settings.trash).toEqual(DEFAULT_SETTINGS.trash);
    expect(problems).toEqual([]);
  });

  test("a bad value costs only its own field", () => {
    const { settings, problems } = parseSettings({
      editor: { fontSize: "big" },
      trash: { ttlDays: 7 },
    });
    expect(settings.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
    expect(settings.trash.ttlDays).toBe(7); // the valid neighbor survives
    expect(problems).toEqual(['"editor.fontSize" must be a number between 6 and 72']);
  });

  test("out-of-range numbers are typos, not intent", () => {
    for (const fontSize of [0, -14, 500, NaN, Infinity]) {
      const { settings, problems } = parseSettings({ editor: { fontSize } });
      expect(settings.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
      expect(problems).toHaveLength(1);
    }
  });

  test("livePreview takes only booleans — a truthy string is a typo", () => {
    expect(parseSettings({ editor: { livePreview: false } }).settings.editor.livePreview).toBe(false);
    const { settings, problems } = parseSettings({ editor: { livePreview: "yes" } });
    expect(settings.editor.livePreview).toBe(DEFAULT_SETTINGS.editor.livePreview);
    expect(problems).toEqual(['"editor.livePreview" must be true or false']);
  });

  test("an empty shell path falls back rather than spawning nothing", () => {
    const { settings, problems } = parseSettings({ shell: { path: "" } });
    expect(settings.shell.path).toBe(DEFAULT_SETTINGS.shell.path);
    expect(problems).toEqual(['"shell.path" must be a non-empty string']);
  });

  test("shell args must all be strings", () => {
    const { settings, problems } = parseSettings({ shell: { args: ["-i", 3] } });
    expect(settings.shell.args).toEqual(DEFAULT_SETTINGS.shell.args);
    expect(problems).toEqual(['"shell.args" must be an array of strings']);
  });

  test("runnable languages are normalized to lowercase", () => {
    const { settings } = parseSettings({ blocks: { runnable: ["Python", "SH"] } });
    expect(settings.blocks.runnable).toEqual(["python", "sh"]);
  });

  test("overriding one interpreter does not un-map the rest", () => {
    const { settings, problems } = parseSettings({
      blocks: { interpreters: { python: "/venv/bin/python", lua: "lua" } },
    });
    expect(settings.blocks.interpreters["python"]).toBe("/venv/bin/python");
    expect(settings.blocks.interpreters["lua"]).toBe("lua"); // user-added language
    expect(settings.blocks.interpreters["node"]).toBe(DEFAULT_SETTINGS.blocks.interpreters["node"]!);
    expect(problems).toEqual([]);
  });

  test("interpreter keys are normalized to lowercase, like runnable", () => {
    const { settings } = parseSettings({ blocks: { interpreters: { Python: "/venv/bin/python" } } });
    expect(settings.blocks.interpreters["python"]).toBe("/venv/bin/python");
  });

  test("a bad interpreter entry costs that language alone", () => {
    const { settings, problems } = parseSettings({
      blocks: { interpreters: { python: "", ruby: "/opt/ruby" } },
    });
    expect(settings.blocks.interpreters["python"]).toBe(DEFAULT_SETTINGS.blocks.interpreters["python"]!);
    expect(settings.blocks.interpreters["ruby"]).toBe("/opt/ruby");
    expect(problems).toEqual(['"blocks.interpreters.python" must be a non-empty string']);
  });

  test("a non-object interpreters field is reported and defaults survive", () => {
    const { settings, problems } = parseSettings({ blocks: { interpreters: ["python3"] } });
    expect(settings.blocks.interpreters).toEqual(DEFAULT_SETTINGS.blocks.interpreters);
    expect(problems).toEqual(['"blocks.interpreters" must be an object of language -> command strings']);
  });

  test("hostInterpreters parses host patterns verbatim, languages lowercased", () => {
    const { settings, problems } = parseSettings({
      blocks: { hostInterpreters: { "deploy@anypost-*": { Python: "/opt/py312/bin/python3" } } },
    });
    expect(settings.blocks.hostInterpreters).toEqual({
      "deploy@anypost-*": { python: "/opt/py312/bin/python3" },
    });
    expect(problems).toEqual([]);
  });

  test("a bad hostInterpreters entry costs that language of that host alone", () => {
    const { settings, problems } = parseSettings({
      blocks: { hostInterpreters: { prod: { python: "", ts: "/opt/bun run" }, db: { python: "/opt/py" } } },
    });
    expect(settings.blocks.hostInterpreters["prod"]).toEqual({ ts: "/opt/bun run" });
    expect(settings.blocks.hostInterpreters["db"]).toEqual({ python: "/opt/py" });
    expect(problems).toEqual(['"blocks.hostInterpreters.prod.python" must be a non-empty string']);
  });

  test("a non-object host section costs that host alone; a non-object field costs the feature", () => {
    const one = parseSettings({ blocks: { hostInterpreters: { prod: "python3", db: { rb: "/opt/ruby" } } } });
    expect(one.settings.blocks.hostInterpreters["prod"]).toEqual({});
    expect(one.settings.blocks.hostInterpreters["db"]).toEqual({ rb: "/opt/ruby" });
    expect(one.problems.length).toBe(1);

    const all = parseSettings({ blocks: { hostInterpreters: ["prod"] } });
    expect(all.settings.blocks.hostInterpreters).toEqual({});
    expect(all.problems).toEqual([
      '"blocks.hostInterpreters" must be an object of host pattern -> language maps',
    ]);
  });

  test("hostInterpreters defaults to empty and stays optional", () => {
    const { settings, problems } = parseSettings({});
    expect(settings.blocks.hostInterpreters).toEqual({});
    expect(problems).toEqual([]);
  });

  test("a misspelled section is reported, not silently ignored", () => {
    const { settings, problems } = parseSettings({ editr: { fontSize: 18 } });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(problems).toEqual(['unknown section "editr"']);
  });

  test("a non-object section is reported and its fields default", () => {
    const { settings, problems } = parseSettings({ editor: 18 });
    expect(settings.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
    expect(problems).toEqual(['"editor" is not an object']);
  });

  test("non-object roots (arrays, strings, null) yield defaults", () => {
    for (const raw of [null, "settings", [1, 2], 42]) {
      const { settings, problems } = parseSettings(raw);
      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(problems).toEqual(["settings.json is not a JSON object"]);
    }
  });
});
