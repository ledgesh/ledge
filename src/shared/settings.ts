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
  blocks: { runnable: string[] };
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  shell: { path: "/bin/zsh", args: ["-i"] },
  editor: { fontSize: 14 },
  terminal: { fontSize: 12 },
  trash: { ttlDays: 30 },
  blocks: {
    runnable: ["sh", "bash", "zsh", "shell", "console", "python", "python3", "py", "ruby", "rb", "node", "js", "javascript"],
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
