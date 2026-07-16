// User preferences: the shape of settings.json, its defaults, and the
// validator. Lives in shared/ because both ends need it — Bun parses the file
// and applies the Bun-side settings (shell, trash TTL); the view receives the
// validated snapshot over RPC and applies the rest (fonts, runnable fences).
//
// The policy for what belongs in here is docs/architecture.md ("Settings");
// the short version: a setting exists only where the hardcoded default
// demonstrably fails someone, and it applies at launch, never live.

export interface Settings {
  // The login shell every PTY runs (per-note inline-run shells and terminal
  // drawers alike). Applied Bun-side at spawn.
  shell: { path: string; args: string[] };
  editor: { fontSize: number };
  terminal: { fontSize: number };
  // How long a deleted note stays recoverable before the launch-time purge
  // evicts it (bun/notes.ts purgeTrash).
  trash: { ttlDays: number };
  // Code-fence languages that get a Run button (editor/blocks.ts). Matched
  // case-insensitively against the fence's info string.
  //
  // `interpreters` maps a fence language to the command that runs its temp
  // file (bun/runner.ts). A language with no entry is sourced into the note's
  // shell — that is what makes ```sh blocks carry cwd/env across runs, and it
  // is also the extension point: add `"lua": "lua"` here (and to `runnable`)
  // and lua fences run. Values are inserted verbatim into a shell command
  // line, so they may carry flags ("python3 -u") and must be quoted by the
  // user if the path has spaces. The literal value "bun" is special-cased to
  // the bun runtime bundled with the app, so TypeScript runs without a bun on
  // PATH. User entries MERGE over these defaults (a venv python should not
  // cost you node), so to un-map a language remove it from `runnable` instead.
  blocks: { runnable: string[]; interpreters: Record<string, string> };
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  shell: { path: "/bin/zsh", args: ["-i"] },
  editor: { fontSize: 14 },
  terminal: { fontSize: 12 },
  trash: { ttlDays: 30 },
  blocks: {
    runnable: [
      "sh", "bash", "zsh", "shell", "console",
      "python", "python3", "py",
      "ruby", "rb",
      "node", "js", "javascript",
      "ts", "typescript",
      "php",
    ],
    interpreters: {
      python: "python3", python3: "python3", py: "python3",
      ruby: "ruby", rb: "ruby",
      node: "node", js: "node", javascript: "node",
      ts: "bun", typescript: "bun",
      php: "php",
    },
  },
});

// Validate a parsed settings.json into a full Settings, field by field: a bad
// value costs THAT field (it falls back to its default and is reported in
// `problems`), never the rest of the file and never a crash. A hand-edited
// JSON file is the UI here, so a typo has to degrade as gently as a blank
// field in a form would.
export function parseSettings(raw: unknown): { settings: Settings; problems: string[] } {
  const problems: string[] = [];
  const d = DEFAULT_SETTINGS;
  const root = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) problems.push("settings.json is not a JSON object");

  // A misspelled section would otherwise be silently ignored, which reads as
  // "my setting does nothing" — say so instead.
  for (const key of Object.keys(root)) {
    if (!(key in d)) problems.push(`unknown section "${key}"`);
  }

  const shell = section(root, "shell", problems);
  const editor = section(root, "editor", problems);
  const terminal = section(root, "terminal", problems);
  const trash = section(root, "trash", problems);
  const blocks = section(root, "blocks", problems);

  return {
    settings: {
      shell: {
        path: str(shell, "path", "shell.path", d.shell.path, problems),
        args: strings(shell, "args", "shell.args", d.shell.args, problems),
      },
      // Font sizes are bounded to what a human could plausibly want: outside
      // 6–72 is far more likely a typo (or a lost decimal point) than intent.
      editor: { fontSize: num(editor, "fontSize", "editor.fontSize", d.editor.fontSize, 6, 72, problems) },
      terminal: { fontSize: num(terminal, "fontSize", "terminal.fontSize", d.terminal.fontSize, 6, 72, problems) },
      trash: { ttlDays: num(trash, "ttlDays", "trash.ttlDays", d.trash.ttlDays, 1, 36500, problems) },
      blocks: {
        runnable: strings(blocks, "runnable", "blocks.runnable", d.blocks.runnable, problems).map((l) =>
          l.toLowerCase(),
        ),
        // Merged, not replaced: setting one interpreter must not un-map the
        // rest (see the field comment on Settings).
        interpreters: {
          ...d.blocks.interpreters,
          ...stringMap(blocks, "interpreters", "blocks.interpreters", problems),
        },
      },
    },
    problems,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function section(root: Record<string, unknown>, key: string, problems: string[]): Record<string, unknown> {
  const v = root[key];
  if (v === undefined) return {};
  if (isRecord(v)) return v;
  problems.push(`"${key}" is not an object`);
  return {};
}

function str(
  o: Record<string, unknown>,
  key: string,
  label: string,
  fallback: string,
  problems: string[],
): string {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v === "string" && v.length > 0) return v;
  problems.push(`"${label}" must be a non-empty string`);
  return fallback;
}

function strings(
  o: Record<string, unknown>,
  key: string,
  label: string,
  fallback: string[],
  problems: string[],
): string[] {
  const v = o[key];
  if (v === undefined) return fallback;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  problems.push(`"${label}" must be an array of strings`);
  return fallback;
}

// Validates per ENTRY, not per map: one bad value costs that language alone,
// matching the file's per-field degradation everywhere else. Keys are fence
// info strings, matched case-insensitively like `runnable`, so lowercase them.
function stringMap(
  o: Record<string, unknown>,
  key: string,
  label: string,
  problems: string[],
): Record<string, string> {
  const v = o[key];
  if (v === undefined) return {};
  if (!isRecord(v)) {
    problems.push(`"${label}" must be an object of language -> command strings`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val.length > 0) out[k.toLowerCase()] = val;
    else problems.push(`"${label}.${k}" must be a non-empty string`);
  }
  return out;
}

function num(
  o: Record<string, unknown>,
  key: string,
  label: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) return v;
  problems.push(`"${label}" must be a number between ${min} and ${max}`);
  return fallback;
}
