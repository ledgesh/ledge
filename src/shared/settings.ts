// User preferences: the shape of settings, the defaults, and the validator.
// Lives in shared/ because both ends need it. Bun parses the files and
// applies the settings it owns (shell, trash TTL); the view receives the
// validated snapshot over RPC and applies the rest (fonts, runnable fences).
// architecture.md §6 says what earns a knob: a setting exists only where the
// hardcoded default demonstrably fails someone, and it applies at launch,
// never live.
//
// One shape, two homes (remote.md §5). `Settings` is a single interface, but
// each section is a fact about one of two things: the machine holding the
// notes (which shell to spawn, how long the trash keeps things, what a
// ```python fence runs) or the screen in front of the user (font sizes, the
// theme, whether markdown syntax is concealed). The first kind lives in the
// server's settings.jsonc, the second in the client's, and SETTINGS_HOMES
// below is the only place that mapping is written down. A phone's font size
// is not a VPS's font size, and no server can know whether the Mac in front
// of the user is in dark mode.
//
// The split is by section, not by field, so `parseSettings` can report "this
// whole section is read from the other file" in one sentence a user can act
// on.

import { folderNameProblem } from "./folders";

// The appearance knob's values: follow the OS, or pin one side.
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export interface Settings {
  // The login shell every PTY runs (per-note inline-run shells and terminal
  // drawers alike). Applied Bun-side at spawn.
  shell: { path: string; args: string[] };
  // `livePreview` conceals markdown syntax away from the caret
  // (editor/livePreview.ts). A code block's content is never concealed either
  // way; only the fence marks are. The knob is an escape hatch, not a
  // preference: the raw view is the app's original stance, and precise syntax
  // editing (or a concealment bug) needs a way back to
  // text-on-screen-is-text-on-disk.
  editor: { fontSize: number; livePreview: boolean };
  terminal: { fontSize: number };
  // Light or dark. "system" (the default) follows the Mac's appearance, which
  // is what the app has always done and what almost everyone wants. The two
  // forced values exist because the OS setting demonstrably fails people whose
  // appearance is not a preference: a Mac on the automatic day/night schedule
  // flipping a notebook mid-session, a bright room or projector where one side
  // is unreadable, a screenshot that has to match the docs. The value is read
  // at launch like every setting, but "system" keeps tracking the OS
  // afterwards: that is the OS changing, not the setting.
  appearance: { theme: Theme };
  // How long a deleted note stays recoverable before the launch-time purge
  // evicts it (bun/notes.ts purgeTrash).
  trash: { ttlDays: number };
  // `runnable` lists the code-fence languages that get a Run button
  // (editor/blocks.ts), matched case-insensitively against the fence's info
  // string. A user's list replaces this one, which is how a language is
  // un-mapped. bun/settings.ts seeds settings.jsonc with the defaults written
  // out in full, so an existing install's list is frozen at seed time. Adding
  // a language below does not reach a seeded file: announce such additions.
  // The user then adds the word to their own list.
  //
  // `interpreters` maps a fence language to the command that runs its temp
  // file (bun/runner.ts). A language with no entry is sourced into the note's
  // shell instead, which is what makes ```sh blocks carry cwd and env across
  // runs. Values are inserted verbatim into a shell line, so they may carry
  // flags ("python3 -u") and the user must quote a path with spaces. The
  // literal value "bun" is special-cased to the bun runtime bundled with the
  // app, so TypeScript runs without a bun on PATH. User entries merge over
  // these defaults (pointing python at a venv should not un-map node), so to
  // un-map a language remove it from `runnable` instead.
  //
  // The map is also the extension point. Adding `"sql": "psql -f"` here and
  // "sql" to `runnable` makes sql fences run. The value is shell text expanded
  // in the note's shell, so it can read the note's own env: the one entry
  // `"psql \"$DATABASE_URL\" -f"` means a different database per note
  // (frontmatter `env:`/`envFile:`/`profile:`). Which engine `sql` means is
  // why it gets no default: unlike "which python", that question has no answer
  // that works for most people, and a wrong guess would source
  // `DELETE FROM ...` into zsh.
  //
  // A ```prompt fence is an agent run. The default maps it to Claude Code's
  // print mode with a trailing `<`, so the shell feeds the block body to the
  // CLI on stdin. Values are shell text, so redirection composes, and
  // `claude -p /tmp/file` without the `<` would read the path as the prompt.
  // The block runs from the note's own shell, so the agent inherits the note's
  // cwd, env, and the $LEDGE_NOTE/$LEDGE_WORKSPACE facts: a prompt block
  // saying "this note" resolves through the Ledge MCP server exactly as it
  // would in the terminal drawer. Point the entry at another stdin-reading
  // CLI to switch agents. A run shows nothing until it finishes, because
  // print mode buffers its answer.
  //
  // `--allowedTools mcp__ledge` pre-authorizes the Ledge MCP server's tools,
  // because print mode is non-interactive: with no one to answer a permission
  // prompt, a write-intent block would run to completion and then report it
  // was not allowed to write. Granting exactly the Ledge tools is safe by the
  // same argument as the server's own stance: they are guarded by the registry
  // and path asserts, and touch nothing the block's shell could not already
  // touch. Every other permission still applies. The LEDGE_PROMPT_BLOCK=1
  // prefix marks the session as a one-shot for the same reason: nobody can
  // answer a follow-up question either, and a model that is not told this
  // ends its reply asking one. The MCP server's initialize instructions read
  // the marker and say "act, don't ask" (bun/mcp.ts).
  //
  // A ```redis fence is a list of redis-cli commands, fed on stdin by the
  // same trailing `<`. It gets a default where `sql` does not, on both counts.
  // The fence word names one canonical client: a Valkey server speaks the same
  // protocol, so `redis-cli` drives it, and the entry can point at `valkey-cli`
  // if that is the binary present. The default target needs no configuration,
  // because `${REDIS_URL:-...}` falls back to localhost, which is the machine
  // a dev's redis is actually on. Set REDIS_URL in a note's frontmatter env
  // (or a profile, for a URL with a password in it) and the same fence points
  // at staging. The default spelling is `-u "${REDIS_URL:-...}"` rather than
  // a bare `${REDIS_URL:+-u "$REDIS_URL"}` because zsh does not word-split an
  // unquoted expansion: the conditional form would hand redis-cli
  // `-u redis://host` as one argument.
  //
  // `hostInterpreters` overrides `interpreters` per target machine, for runs
  // a note's `host:` frontmatter sends elsewhere: the base map otherwise runs
  // verbatim everywhere, and "which python" can differ on prod. Keys are host
  // patterns matched against the run's ssh destination ("deploy@prod-01", or
  // the reserved "local"), `*` matches any run of characters (one entry covers
  // a numbered fleet: "deploy@anypost-*"), and every matching section merges
  // over the base in file order, later keys winning. Why this is a setting
  // rather than frontmatter: architecture.md §6.
  blocks: {
    runnable: string[];
    interpreters: Record<string, string>;
    hostInterpreters: Record<string, Record<string, string>>;
  };
  // Daily notes: one note per local calendar day, titled YYYY-MM-DD, reached
  // by ⌘J or `ledge today` (create-or-open, idempotent). `workspace` names
  // where they live: a registered root's absolute path (~ expands) or its
  // folder name. An empty string means unset, and the deixis default applies
  // (the selected workspace in the app, cwd at the CLI). That default
  // demonstrably scatters daily notes for anyone with more than one
  // workspace. "Where is today's note?" is the feature's one promise, so the
  // knob is earned. It stays a knob because a workspace is not a note: there
  // is no corpus object to carry the fact. A value naming no registered root
  // degrades to the default, reported, never an error.
  //
  // Which note seeds the day is not set here. Mark that note with
  // `template: daily` in its own frontmatter. The retired `template` field
  // named a note by title, which went stale on rename.
  //
  // `folder` names where inside that workspace, for anyone who keeps a
  // journal in one: a workspace-relative path with forward slashes, empty
  // meaning the top level. It degrades differently from `workspace`. A name
  // that is not a folder name is reported and ignored, so a typo cannot break
  // ⌘J. A name the store then refuses (an ignored folder, say) is an error at
  // the keystroke instead, because that message names the exact fix. Both
  // arguments, and why the knob is earned: architecture.md §6.
  daily: { workspace: string; folder: string };
  // There is no templates section. Which notes are templates is corpus data,
  // not configuration: a note declares itself with `template: true`
  // frontmatter, and the ⌥⌘N picker reads the live note lists. A registry
  // here would need hand-editing, would apply only after a restart, and would
  // go stale against renames.
}

// Which file each section is read from. A section added to `Settings` without
// an entry here does not compile, thanks to the `satisfies` clause, so no knob
// can be added without deciding whose fact it is.
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
 * it. Both arguments are a full `Settings` because each file parses into one,
 * holding defaults in the sections it does not own. Every consumer then reads
 * one whole object and need not know there were ever two files.
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
  daily: { workspace: "", folder: "" },
});

// What first launch writes to settings.jsonc, every default spelled out. The
// file is the settings UI (architecture.md §6), so its comments are the
// documentation, restating the `Settings` field docs above in user terms:
// keep the two saying the same thing. A drift test in settings.test.ts pins
// the template to DEFAULT_SETTINGS, so a default cannot change without this
// file changing too. The seed only reaches new installs (an existing file is
// never rewritten), so announce a default change rather than only editing it.
//
// `shellPath` is an argument because the answer differs per machine and this
// file cannot ask: nothing in shared/ may depend on Bun
// (shared/portable.test.ts). Bun passes the account's own login shell where
// Ledge supports it (bun/spawnParams.ts `resolveShellPath`). The seeded file
// gets that concrete path, never a sentinel like "auto": the file is the
// settings UI, so it has to name what will run and stay editable to something
// else on one line.
export function settingsTemplate(shellPath: string): string {
  return `// Ledge settings, for the machine holding the notes. The file is the settings
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
  // The login shell every terminal drawer and inline run spawns. Seeded with
  // this machine's own, if that is zsh or bash: the shells Ledge can read.
  "shell": {
    "path": "${shellPath}",
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
    "workspace": "",
    // Which folder inside that workspace, like "journal" or "log/2026".
    // Empty means the top level. Only used when a day's note is CREATED: an
    // existing one is found by its date wherever it already sits.
    "folder": ""
  }
}
`;
}

// The client's half of the settings file. Both templates are generated, but
// this one substitutes every value rather than only the one the server's
// cannot know: it has two jobs where the server's has one. It seeds a fresh
// install with the defaults, and it carries an existing install's values
// across at the split (bun/clientSettings.ts). One set of comments serves both
// jobs; a fixed template plus a patcher would either lose the comments or have
// to edit JSONC text.
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

// Validates one parsed settings file into a full Settings, field by field. A
// bad value costs only that field: it falls back to its default and is listed
// in `problems`, never taking down the rest of the file and never crashing.
// A hand-edited JSON file is the UI here, so a typo has to stay recoverable.
//
// The `home` argument says which file this is (see SETTINGS_HOMES). Sections
// belonging to the other file are not read: they take their defaults and are
// reported, so a value left behind by the split reads as ignored with a
// pointer to where it went rather than as a setting that silently does
// nothing. The result is still a full Settings, and mergeSettings joins the
// two halves.
export function parseSettings(raw: unknown, home: SettingsHome): { settings: Settings; problems: string[] } {
  const problems: string[] = [];
  const d = DEFAULT_SETTINGS;
  const root = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) problems.push("the settings file is not a JSON object");

  // Report a misspelled section instead of ignoring it, which would read as
  // "my setting does nothing". "templates" gets its own message: it was
  // briefly a real section (a list of template note titles), so a file still
  // carrying it gets a pointer to what replaced it.
  for (const key of Object.keys(root)) {
    if (key === "templates") {
      problems.push(`"templates" is retired — mark a note with \`template: true\` frontmatter instead`);
    } else if (!(key in d)) problems.push(`unknown section "${key}"`);
    else if (SETTINGS_HOMES[key as keyof Settings] !== home) problems.push(elsewhere(key as keyof Settings));
  }

  // Read only this file's own sections. The rest resolve to `{}`, so every
  // field below falls back to its default. mergeSettings discards those
  // defaults in favor of the other file's values.
  const mine = (key: keyof Settings) => (SETTINGS_HOMES[key] === home ? section(root, key, problems) : {});
  const shell = mine("shell");
  const editor = mine("editor");
  const terminal = mine("terminal");
  const appearance = mine("appearance");
  const trash = mine("trash");
  const blocks = mine("blocks");
  const daily = mine("daily");
  // Like the retired "templates" section: `daily.template` was briefly a real
  // field (a note title), so a file still carrying it gets a pointer.
  if ("template" in daily) {
    problems.push(`"daily.template" is retired — mark the note itself with \`template: daily\` frontmatter instead`);
  }

  return {
    settings: {
      shell: {
        path: str(shell, "path", "shell.path", d.shell.path, problems),
        args: strings(shell, "args", "shell.args", d.shell.args, problems),
      },
      // Font sizes are bounded to 6 through 72. A value outside that range is
      // more likely a typo, or a lost decimal point, than a real preference.
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
        folder: folderName(daily, "folder", "daily.folder", problems),
      },
    },
    problems,
  };
}

// Validates blocks.hostInterpreters: an object of host pattern -> language
// map. A host section that is not an object costs that host alone, and
// degrades per entry inside it via the same stringMap every language map uses.
// Host patterns are kept verbatim: case and "*" are the matcher's business
// (bun/runner.ts interpretersFor), and a pattern that matches nothing is not
// an error.
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

// The message for a section that is in the wrong file. It describes the
// section rather than naming a path: shared/ knows neither file's location,
// and the two ends may not be the same machine. bun/clientSettings.ts carries
// the values across once at the split, so the section left behind is a
// leftover to delete, not a setting to move by hand.
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

// Like str, but "" is a meaning here rather than a typo: folderName and optStr
// spell "unset" as an empty string, so the seeded file can show the knob blank
// and stay valid JSON without nulls.
//
// folderName returns a folder name, or "". It applies the shape rule the store
// uses when it turns a name into a directory (shared/folders.ts, bun/notes.ts
// folderPathOf), so a bad name is reported while the file is being edited
// rather than at the next ⌘J. A bad name falls back to "" and is listed in
// `problems`, the way every other field falls back to its default rather than
// failing a launch.
function folderName(o: Record<string, unknown>, key: string, label: string, problems: string[]): string {
  const value = optStr(o, key, label, problems);
  const problem = folderNameProblem(value);
  if (problem === null) return value;
  problems.push(`"${label}" is not a folder: ${value} (${problem})`);
  return "";
}

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

// Accepts a closed set of spellings. Anything else is a typo, or a value from
// a newer Ledge. The message names every accepted word, so the file can be
// fixed without opening the manual.
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

// Validates per entry, not per map: one bad value costs that language alone,
// matching the per-field fallback everywhere else in the file. Keys are fence
// info strings, matched case-insensitively like `runnable`, so this
// lowercases them.
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
