// User preferences: the shape of settings, the defaults, and the validator.
// Lives in shared/ because both ends need it — Bun parses the files and
// applies the Bun-side settings (shell, trash TTL); the view receives the
// validated snapshot over RPC and applies the rest (fonts, runnable fences).
//
// The policy for what belongs in here is architecture.md ("Settings");
// the short version: a setting exists only where the hardcoded default
// demonstrably fails someone, and it applies at launch, never live.
//
// ONE SHAPE, TWO HOMES (remote.md §5). `Settings` is a single interface, but
// each of its sections is a fact about one of two things: the machine holding
// the notes (which shell to spawn, how long the trash keeps things, what a
// ```python fence runs) or the screen in front of you (font sizes, the theme,
// whether markdown syntax is concealed). The first kind lives in the SERVER's
// settings.jsonc, the second in the CLIENT's, and SETTINGS_HOMES below is the
// only place that mapping is written down. A phone's font size is not a VPS's
// font size, and no server can know whether this Mac is in dark mode.
//
// The split is by section, not by field, which is not a simplification: it is
// the reason `parseSettings` can say "this whole section is read from the
// other file" in one sentence a user can act on.

// The appearance knob's values: follow the OS, or pin one side.
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

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
  // Light or dark. "system" (the default) follows the Mac's appearance, which
  // is what the app has always done and what almost everyone wants; the two
  // forced values exist because the OS setting demonstrably fails people whose
  // appearance is not a preference — a Mac on the automatic day/night schedule
  // flipping a notebook mid-session, a projector or a bright room where one
  // side is simply unreadable, a screenshot that has to match the docs. Read
  // at launch like every setting, but "system" keeps tracking the OS live
  // afterwards: that is the OS changing, not the setting.
  appearance: { theme: Theme };
  // How long a deleted note stays recoverable before the launch-time purge
  // evicts it (bun/notes.ts purgeTrash).
  trash: { ttlDays: number };
  // Code-fence languages that get a Run button (editor/blocks.ts). Matched
  // case-insensitively against the fence's info string. A user's list
  // REPLACES this one (that is how a language is un-mapped) — and since
  // bun/settings.ts seeds settings.jsonc with the defaults written out in
  // full, an existing install's file has this list frozen at seed time:
  // adding a language to the default below does NOT reach seeded files, so
  // announce such additions (the user adds the word to their own list).
  //
  // `interpreters` maps a fence language to the command that runs its temp
  // file (bun/runner.ts). A language with no entry is sourced into the note's
  // shell — that is what makes ```sh blocks carry cwd/env across runs, and it
  // is also the extension point: add `"sql": "psql -f"` here (and to
  // `runnable`) and sql fences run, against whatever connection the note's own
  // env names (frontmatter `env:`/`envFile:`/`profile:`), because the value is
  // shell text expanded in the note's shell: `"psql \"$DATABASE_URL\" -f"` is
  // one entry that means a different database per note. Which engine `sql`
  // means is exactly why it is not a default: unlike "which python", there is
  // no answer that works for most people, and a wrong guess would source
  // `DELETE FROM ...` into zsh. Values are inserted verbatim into a shell
  // line, so they may carry flags ("python3 -u") and must be quoted by the
  // user if the path has spaces. The literal value "bun" is special-cased to
  // the bun runtime bundled with the app, so TypeScript runs without a bun on
  // PATH. User entries MERGE over these defaults (a venv python should not
  // cost you node), so to un-map a language remove it from `runnable` instead.
  //
  // A ```prompt fence is an agent run: the default maps it to Claude Code's
  // print mode, with a trailing `<` so the shell feeds the block body to the
  // CLI on stdin — values are shell text, so redirection composes, and
  // `claude -p /tmp/file` without it would read the PATH as the prompt.
  // Because the block runs from the note's own shell, the agent inherits the
  // note's cwd, env, and the $LEDGE_NOTE/$LEDGE_WORKSPACE facts, so a prompt
  // block saying "this note" resolves through the Ledge MCP server exactly
  // as it would in the terminal drawer. `--allowedTools mcp__ledge`
  // pre-authorizes that server's tools, because print mode is
  // non-interactive: there is no one to answer a permission prompt, so
  // without it a write-intent block runs to completion and then reports it
  // was not allowed to write. Granting exactly the Ledge tools is safe by
  // the same argument as the server's own stance — they are guarded by the
  // registry and path asserts, and touch nothing the block's shell could not
  // already touch. Every OTHER permission still applies. The LEDGE_PROMPT_BLOCK=1
  // prefix marks the session as a one-shot for the same reason: nobody can
  // answer a follow-up question either, and without being told, the model
  // ends its reply asking one (the MCP server's initialize instructions read
  // the marker and say "act, don't ask" — bun/mcp.ts). Expect silence until
  // the run finishes: print mode buffers its answer. Point the entry at
  // another stdin-reading CLI to switch agents.
  //
  // A ```redis fence is a list of redis-cli commands, fed on stdin by the same
  // trailing `<`. It earns a default where `sql` does not, on both counts:
  // the fence word names one canonical client (a Valkey server speaks the
  // same protocol, so `redis-cli` drives it — point the entry at `valkey-cli`
  // if that is the binary you have), and the default target is honest with no
  // configuration at all, because `${REDIS_URL:-...}` falls back to localhost,
  // which is the machine a dev's redis is actually on. Set REDIS_URL in a
  // note's frontmatter env (or a profile, for a URL with a password in it) and
  // the same fence points at staging. The default spelling is
  // `-u "${REDIS_URL:-...}"` rather than a bare `${REDIS_URL:+-u "$REDIS_URL"}`
  // because zsh does not word-split an unquoted expansion: the conditional form
  // would hand redis-cli `-u redis://host` as ONE argument.
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
  // Daily notes: one note per LOCAL calendar day, titled YYYY-MM-DD, reached
  // by ⌘J / `ledge today` (create-or-open, idempotent). `workspace` pins
  // where they live — a registered root's absolute path (~ expands) or its
  // folder name. It earns its knob because the deixis default (the selected
  // workspace in the app, cwd at the CLI) demonstrably scatters daily notes
  // for anyone with more than one workspace, and "where is today's note?" is
  // the feature's one promise — and it stays a knob because a workspace is
  // not a note: there is no corpus object to carry the fact. Empty string
  // means unset (deixis); a value naming no registered root degrades,
  // reported, never an error. WHICH note seeds the day is NOT here: mark
  // that note `template: daily` in its own frontmatter — the retired
  // `template` field named a note by title, which went stale on rename.
  daily: { workspace: string };
  // There is deliberately no templates section: which notes are templates is
  // corpus data, not configuration — a note declares itself with
  // `template: true` frontmatter, and the ⌥⌘N picker reads the live note
  // lists. A registry here would need hand-editing, restart to apply, and
  // would go stale against renames; the marker needs none of that.
}

// Which file each section is read from. The `satisfies` is the point: a
// section added to `Settings` without an entry here does not compile, so
// nobody can add a knob without deciding whose fact it is.
export type SettingsHome = "server" | "client";

export const SETTINGS_HOMES = {
  shell: "server",
  editor: "client",
  terminal: "client",
  appearance: "client",
  trash: "server",
  blocks: "server",
  daily: "server",
} as const satisfies Record<keyof Settings, SettingsHome>;

export function homeOf(section: keyof Settings): SettingsHome {
  return SETTINGS_HOMES[section];
}

/**
 * The snapshot the view runs on: each section taken from the file that owns
 * it. Both arguments are full `Settings` because each file parses into one
 * (the sections it does not own hold defaults), which keeps every consumer
 * reading one whole object and unaware there were ever two files.
 */
export function mergeSettings(server: Settings, client: Settings): Settings {
  return {
    shell: server.shell,
    editor: client.editor,
    terminal: client.terminal,
    appearance: client.appearance,
    trash: server.trash,
    blocks: server.blocks,
    daily: server.daily,
  };
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  shell: { path: "/bin/zsh", args: ["-i"] },
  editor: { fontSize: 14, livePreview: true },
  terminal: { fontSize: 12 },
  appearance: { theme: "system" as Theme },
  trash: { ttlDays: 30 },
  blocks: {
    runnable: [
      "sh", "bash", "zsh", "shell", "console",
      "python", "python3", "py",
      "ruby", "rb",
      "node", "js", "javascript",
      "ts", "typescript",
      "php",
      "redis",
      "prompt",
    ],
    interpreters: {
      python: "python3", python3: "python3", py: "python3",
      ruby: "ruby", rb: "ruby",
      node: "node", js: "node", javascript: "node",
      ts: "bun", typescript: "bun",
      php: "php",
      redis: 'redis-cli -u "${REDIS_URL:-redis://127.0.0.1:6379}" <',
      prompt: "LEDGE_PROMPT_BLOCK=1 claude --allowedTools mcp__ledge -p <",
    },
    hostInterpreters: {},
  },
  daily: { workspace: "" },
});

// What first launch writes to settings.jsonc: every default spelled out, with
// the comments AS the documentation — the file is the settings UI
// (architecture.md §6), so it has to explain itself in user terms. The
// comments here are the user-facing distillation of the field docs on
// `Settings` above; keep the two telling the same story. A drift test in
// settings.test.ts pins the template to DEFAULT_SETTINGS, so a default cannot
// change without this file changing with it — but remember the seed only
// reaches NEW installs (an existing file is never rewritten): announce default
// changes, don't just edit them here.
export const SETTINGS_TEMPLATE = `// Ledge settings, for the machine holding the notes. The file is the settings
// UI: edit it here (⌘,), relaunch to apply; no setting applies live. This is
// JSONC: comments (and trailing commas) are fine. A bad value falls back to
// its default with a warning in the launch log; it never takes the rest of
// the file down.
//
// Font sizes, the theme, and live preview are NOT here. Those describe the
// screen you are reading this on rather than the machine the notes are
// stored on, so they live in this app's own settings file — the other tab
// in the ⌘, dialog.
{
  // The login shell every terminal drawer and inline run spawns.
  "shell": {
    "path": "/bin/zsh",
    "args": ["-i"]
  },

  // How many days a deleted note stays recoverable in the trash before the
  // launch-time purge removes it for good.
  "trash": {
    "ttlDays": 30
  },

  "blocks": {
    // Code-fence languages that get a Run button, matched case-insensitively
    // against the fence's info string. This list REPLACES the default set:
    // removing a word here is how a language is un-mapped, and a new language
    // needs an entry here AND (unless it should run in the note's shell) in
    // "interpreters" below.
    "runnable": [
      "sh", "bash", "zsh", "shell", "console",
      "python", "python3", "py",
      "ruby", "rb",
      "node", "js", "javascript",
      "ts", "typescript",
      "php",
      "redis",
      "prompt"
    ],

    // Fence language -> the command that runs its code. Languages NOT named
    // here are sourced into the note's own shell instead, which is what lets
    // \`\`\`sh blocks carry cwd and env from block to block. Entries MERGE over
    // these defaults (a venv python does not cost you node); values are shell
    // text, so flags are fine ("python3 -u") and paths with spaces need
    // quotes. "bun" is special-cased to the runtime bundled with the app.
    //
    // Because the value is shell text expanded in the note's own shell, it can
    // read the note's env: that is how one entry serves many targets. Adding
    //
    //   "sql": "psql \\"$DATABASE_URL\\" -f"
    //
    // here and "sql" to "runnable" above makes \`\`\`sql fences run against
    // whichever database the note's frontmatter (env:, envFile:, profile:)
    // names. There is no default for "sql" because the word does not say which
    // engine you mean: swap psql for mysql, sqlite3, or duckdb to suit.
    //
    // "redis" pipes the block's commands to redis-cli, at $REDIS_URL or your
    // local server. A Valkey server speaks the same protocol; if valkey-cli is
    // the binary you have, name it here instead.
    //
    // "prompt" makes \`\`\`prompt fences agent runs: the block body is piped to
    // Claude Code's print mode on stdin, in the note's own shell, so the
    // agent inherits the note's cwd and env, and "this note" resolves through
    // the Ledge MCP tools (pre-authorized by --allowedTools). Point it at any
    // other stdin-reading CLI to switch agents.
    "interpreters": {
      "python": "python3", "python3": "python3", "py": "python3",
      "ruby": "ruby", "rb": "ruby",
      "node": "node", "js": "node", "javascript": "node",
      "ts": "bun", "typescript": "bun",
      "php": "php",
      "redis": "redis-cli -u \\"\${REDIS_URL:-redis://127.0.0.1:6379}\\" <",
      "prompt": "LEDGE_PROMPT_BLOCK=1 claude --allowedTools mcp__ledge -p <"
    },

    // Per-machine overrides of "interpreters", for runs a note's \`host:\`
    // frontmatter sends elsewhere ("which python" can differ on prod). Keys
    // are host patterns matched against the ssh destination: "deploy@prod-01",
    // "*" wildcards a fleet ("deploy@web-*"), and "local" is this machine.
    // Every matching section merges over the base in file order, later wins.
    //
    //   "hostInterpreters": {
    //     "deploy@web-*": { "python": "/opt/py311/bin/python" }
    //   }
    "hostInterpreters": {}
  },

  "daily": {
    // Where daily notes (⌘J) live: a registered workspace's folder name or
    // absolute path. Empty means "wherever you are" (the selected workspace
    // in the app, the nearest one at the CLI), which scatters daily notes if
    // you work in more than one. (WHICH note seeds the day is not a setting:
    // mark a note \`template: daily\` in its frontmatter.)
    "workspace": ""
  }
}
`;

// The client's half of the file, and the only template that is generated
// rather than a constant. It has two jobs the server's has one of: seeding a
// fresh install with the defaults, AND carrying an existing install's values
// across when the split happens (bun/clientSettings.ts). Substituting the
// values keeps one set of comments doing both, where a constant template plus
// a patcher would mean either losing the comments or editing JSONC text.
//
// A drift test round-trips this through parseSettings, so a knob added to a
// client section without a line here fails.
export function clientSettingsTemplate(s: Settings): string {
  return `// Ledge settings for this app, on this screen. Edit here (⌘,), relaunch to
// apply; no setting applies live. This is JSONC: comments (and trailing
// commas) are fine. A bad value falls back to its default with a warning in
// the launch log; it never takes the rest of the file down.
//
// Everything here is a fact about the display in front of you, which is why
// it stays with the app rather than with the notes: connect to another
// machine's notes and these come with you. The shell, the trash lifetime, and
// what a code fence runs are that machine's business and live in its own
// settings file — the other tab in this dialog.
{
  "editor": {
    "fontSize": ${s.editor.fontSize},
    // Conceal markdown syntax away from the caret (bold shows bold, not
    // **bold**). Set false to always see exactly the text on disk: the
    // escape hatch for precise syntax editing.
    "livePreview": ${s.editor.livePreview}
  },

  "terminal": {
    "fontSize": ${s.terminal.fontSize}
  },

  "appearance": {
    // "system" follows your Mac's light/dark appearance, and keeps following
    // it while Ledge runs. Set "light" or "dark" to pin one side regardless:
    // for a Mac on the automatic day/night schedule, a room where one side is
    // unreadable, or screenshots that have to match.
    "theme": ${JSON.stringify(s.appearance.theme)}
  }
}
`;
}

// Validate one parsed settings file into a full Settings, field by field: a
// bad value costs THAT field (it falls back to its default and is reported in
// `problems`), never the rest of the file and never a crash. A hand-edited
// JSON file is the UI here, so a typo has to degrade as gently as a blank
// field in a form would.
//
// `home` says WHICH file this is (see SETTINGS_HOMES). Sections belonging to
// the other one are not read — they take their defaults and are reported, so
// a value left behind by the split reads as "this is ignored, and here is
// where it went" rather than as a setting that silently does nothing. The
// result is still a full Settings; mergeSettings puts the two halves together.
export function parseSettings(raw: unknown, home: SettingsHome): { settings: Settings; problems: string[] } {
  const problems: string[] = [];
  const d = DEFAULT_SETTINGS;
  const root = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) problems.push("the settings file is not a JSON object");

  // A misspelled section would otherwise be silently ignored, which reads as
  // "my setting does nothing" — say so instead. "templates" gets its own
  // message: the section existed briefly (a list of template note titles) and
  // a file still carrying it deserves the pointer, not a shrug.
  for (const key of Object.keys(root)) {
    if (key === "templates") {
      problems.push(`"templates" is retired — mark a note with \`template: true\` frontmatter instead`);
    } else if (!(key in d)) problems.push(`unknown section "${key}"`);
    else if (SETTINGS_HOMES[key as keyof Settings] !== home) problems.push(elsewhere(key as keyof Settings));
  }

  // Only this file's own sections are read; the rest resolve to `{}` and every
  // field below falls back to its default, which is exactly what the merge
  // discards in favor of the other file's answer.
  const mine = (key: keyof Settings) => (SETTINGS_HOMES[key] === home ? section(root, key, problems) : {});
  const shell = mine("shell");
  const editor = mine("editor");
  const terminal = mine("terminal");
  const appearance = mine("appearance");
  const trash = mine("trash");
  const blocks = mine("blocks");
  const daily = mine("daily");
  // Like the retired "templates" section: the field existed briefly (a note
  // title), and a file still carrying it deserves the pointer, not silence.
  if ("template" in daily) {
    problems.push(`"daily.template" is retired — mark the note itself with \`template: daily\` frontmatter instead`);
  }

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
      appearance: {
        theme: oneOf(appearance, "theme", "appearance.theme", THEMES, d.appearance.theme, problems),
      },
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
      daily: {
        workspace: optStr(daily, "workspace", "daily.workspace", problems),
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

// The message for a section that is in the wrong file. Said in terms of what
// the section IS rather than of a path, because shared/ knows neither file's
// location and the two ends may not even be the same machine. The values are
// carried across once, at the split (bun/clientSettings.ts), so this is a
// leftover to delete rather than a setting to move by hand.
function elsewhere(section: keyof Settings): string {
  return SETTINGS_HOMES[section] === "client"
    ? `"${section}" describes this screen, so it moved to this app's own settings; the copy here does nothing`
    : `"${section}" describes the machine holding the notes, so it lives in that server's settings; the copy here does nothing`;
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

// Like str, but "" is a meaning, not a typo: these fields spell "unset" as an
// empty string so the seeded file can show the knob blank and stay valid JSON
// without nulls.
function optStr(
  o: Record<string, unknown>,
  key: string,
  label: string,
  problems: string[],
): string {
  const v = o[key];
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  problems.push(`"${label}" must be a string`);
  return "";
}

// A closed set of spellings: anything else is a typo (or a value from a newer
// Ledge), and the message names every accepted word so the file can be fixed
// without opening the manual.
function oneOf<T extends string>(
  o: Record<string, unknown>,
  key: string,
  label: string,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  problems.push(`"${label}" must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
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
