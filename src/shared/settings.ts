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
  // `livePreview` conceals markdown syntax where the caret is not
  // (editor/livePreview.ts). The knob earns its place as the escape hatch,
  // not a preference: the raw view is the app's original deliberate stance,
  // and precise syntax editing (or any concealment bug) demonstrably needs a
  // way back to text-on-screen-is-text-on-disk. Code block CONTENT is never
  // concealed either way — only the fence marks are.
  editor: { fontSize: number; livePreview: boolean };
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
  //
  // `hostInterpreters` overrides `interpreters` per target machine, for runs
  // a note's `host:` frontmatter sends elsewhere: the base map runs verbatim
  // on every machine, and "which python" can have a different answer on
  // prod than here — the same fact that earned `interpreters` its existence,
  // one axis up. Keys are host patterns matched against the run's ssh
  // destination ("deploy@prod-01", or the reserved "local"); `*` matches any
  // run of characters, so one entry covers a numbered fleet
  // ("deploy@anypost-*"). Every matching section merges over the base in
  // file order, later keys winning. Machine facts live HERE, not in
  // frontmatter: the same host appears in many notes, and its toolchain
  // layout is one fact about one machine, not a per-note choice.
  blocks: {
    runnable: string[];
    interpreters: Record<string, string>;
    hostInterpreters: Record<string, Record<string, string>>;
  };
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  shell: { path: "/bin/zsh", args: ["-i"] },
  editor: { fontSize: 14, livePreview: true },
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
    hostInterpreters: {},
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
      editor: {
        fontSize: num(editor, "fontSize", "editor.fontSize", d.editor.fontSize, 6, 72, problems),
        livePreview: bool(editor, "livePreview", "editor.livePreview", d.editor.livePreview, problems),
      },
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
        hostInterpreters: hostMaps(blocks, problems),
      },
    },
    problems,
  };
}

// blocks.hostInterpreters: an object of host pattern -> language map. Degrades
// per host section (a section that is not an object costs that host alone) and
// then per entry inside it, via the same stringMap every language map uses.
// Host patterns are kept verbatim — case and "*"s are the matcher's business
// (bun/runner.ts interpretersFor), and a pattern that matches nothing is not
// an error, just a section that never applies.
function hostMaps(blocks: Record<string, unknown>, problems: string[]): Record<string, Record<string, string>> {
  const v = blocks["hostInterpreters"];
  if (v === undefined) return {};
  if (!isRecord(v)) {
    problems.push(`"blocks.hostInterpreters" must be an object of host pattern -> language maps`);
    return {};
  }
  const out: Record<string, Record<string, string>> = {};
  for (const host of Object.keys(v)) {
    out[host] = stringMap(v, host, `blocks.hostInterpreters.${host}`, problems);
  }
  return out;
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

function bool(
  o: Record<string, unknown>,
  key: string,
  label: string,
  fallback: boolean,
  problems: string[],
): boolean {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  problems.push(`"${label}" must be true or false`);
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
