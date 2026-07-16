import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, parseSettings } from "./settings";

describe("parseSettings", () => {
  test("an empty object yields the defaults, problem-free", () => {
    const { settings, problems } = parseSettings({});
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(problems).toEqual([]);
  });

  test("a full valid file round-trips", () => {
    const input = {
      shell: { path: "/opt/homebrew/bin/fish", args: ["-l"] },
      editor: { fontSize: 16 },
      terminal: { fontSize: 13 },
      trash: { ttlDays: 7 },
      blocks: { runnable: ["sh", "python"] },
    };
    const { settings, problems } = parseSettings(input);
    expect(settings).toEqual(input);
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
