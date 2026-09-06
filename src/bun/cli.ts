// The Ledge CLI: notes from a shell prompt. Like the MCP server, `ledge` is a
// separate process that reuses the bun-side store, and it dispatches through
// the same McpTool handlers agents call (architecture.md §1). Title
// resolution, workspace deixis, H1-slug naming and the divergence guard
// therefore have one definition, so `ledge append` and an agent's append_note
// cannot drift apart. The running app sees a CLI write as an ordinary
// external edit, through its watcher.
//
// Deixis: inside a note's terminal, $LEDGE_NOTE and $LEDGE_WORKSPACE name
// "here" (architecture.md §2) and the handlers honor them. The CLI adds the
// working directory to that chain. A cwd inside a registered root is "here",
// so `ledge new` in a project workspace creates there and ls and search scope
// there. The CLI expresses that by setting $LEDGE_WORKSPACE around the
// handler call, not by a parallel resolution rule. An explicit --workspace
// outranks it, in the same way it outranks the env.
//
// A cwd below the root names a folder as well (cwdFolder), which ls, search,
// tags and new honor. The folder rides as an argument: there is no
// $LEDGE_FOLDER and should not be, because a note's terminal spawns in $HOME
// or the note's own `cwd:`, and neither says where the note is filed. Naming
// a workspace (-w) or going wide (--all) means the whole of it; --folder
// outranks everything.
//
// Results go to stdout (raw text for `cat`, one row per line for lists, the
// handler's JSON under --json) and everything conversational to stderr, so a
// pipe never has to strip chatter. Exit codes: 0 ok, 1 failure (including a
// search with no hits, grep's contract), 2 usage. interactions.md §9 governs
// the verb table.
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { serve } from "./mcp";
import { ledgeTools, resolveNoteForOpen } from "./mcpTools";
import { installShim, tildify } from "./cliShim";
import { writeOpenRequest } from "./openRequest";
import { loadWorkspaces, rootContaining, roots, workspaceMatches } from "./workspaces";

export { tildify }; // display formatting; defined in cliShim.ts so the app's install handler shares it

/** The app's bundle identifier: how `open -b` finds it without a path. */
export const BUNDLE_ID = "sh.ledge.app";

// This module's own location: what an installed shim execs. Resolves to
// src/bun/cli.ts in a checkout and Resources/app/bun/cli.js in the bundle.
const CLI_ENTRY = import.meta.path;

// --- pure helpers (unit-tested in cli.test.ts) -------------------------------

export interface CliFlags {
  workspace?: string;
  folder?: string;
  heading?: string;
  message?: string;
  template?: string;
  json: boolean;
  all: boolean;
  help: boolean;
}

export interface ParsedCli {
  verb: string;
  positionals: string[];
  flags: CliFlags;
}

// Hand-rolled argv parsing (architecture.md §8: a flag loop is less code than
// a library's config). Flags may sit anywhere. `--` ends flag parsing, so a
// title that starts with a dash stays reachable.
export function parseCliArgs(argv: readonly string[]): ParsedCli | { error: string } {
  const flags: CliFlags = { json: false, all: false, help: false };
  const positionals: string[] = [];
  const valued: Record<string, "workspace" | "folder" | "heading" | "message" | "template"> = {
    "--workspace": "workspace",
    "-w": "workspace",
    "--folder": "folder",
    "-f": "folder",
    "--heading": "heading",
    "--message": "message",
    "-m": "message",
    "--template": "template",
  };
  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (literal || !a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    if (a === "--") {
      literal = true;
      continue;
    }
    const key = valued[a];
    if (key !== undefined) {
      const v = argv[i + 1];
      if (v === undefined) return { error: `${a} needs a value` };
      flags[key] = v;
      i += 1;
      continue;
    }
    if (a === "--json") flags.json = true;
    else if (a === "--all" || a === "-a") flags.all = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else return { error: `unknown flag: ${a}` };
  }
  const [verb = "", ...rest] = positionals;
  return { verb, positionals: rest, flags };
}

/**
 * The folder the caller is standing in, relative to their workspace root: the
 * cwd deixis one level deeper than the workspace. After `cd ~/notes/projects`,
 * `ls`, `search` and `tags` narrow to `projects` and `new` creates there.
 *
 * Returns "" for a cwd that is the root itself, outside every root, or below
 * a dot-directory. The dot-directories are Ledge's own storage (.ledge-trash,
 * .ledge-assets) and a project's .git. No note may go in one (folderPathOf
 * refuses them), so standing in one means the workspace rather than an error
 * about a folder the caller never typed.
 */
export function cwdFolder(cwd: string, root: string | null): string {
  if (root === null) return "";
  const rel = relative(resolve(root), resolve(cwd));
  if (rel === "" || rel.startsWith("..")) return "";
  const parts = rel.split(sep);
  return parts.some((part) => part.startsWith(".")) ? "" : parts.join("/");
}

// A search hit's path as a shell user reads one: relative when the hit is
// under the cwd (what grep prints inside a workspace), ~-shortened otherwise.
// Never a path starting with "..": the ~-shortened path it falls back to is
// easier to read in a result list.
export function hitPath(p: string, cwd: string, home: string = homedir()): string {
  const rel = relative(cwd, p);
  return rel === "" || rel.startsWith("..") ? tildify(p, home) : rel;
}

/** ls rows: title column padded, date, then the variable-width path last. */
export function formatNoteList(
  notes: ReadonlyArray<{ title: string; path: string; modified: string; template?: true | "daily"; locked?: boolean }>,
  home: string = homedir(),
): string[] {
  const rows = notes.map((n) => ({
    title: n.title,
    date: n.modified.slice(0, 10),
    path: tildify(n.path, home),
    // The `template:` frontmatter marker is shown where the notes are listed.
    // It is the same marker that fills the app's ⌥⌘N picker (interactions.md
    // §9). A trailing tag rather than a column, since most rows have nothing
    // to say. `(locked)` uses the same slot, so a row carries one marker: the
    // shell says up front which rows `cat` and `search` will not serve.
    tag: n.template === "daily" ? "  (daily template)" : n.template ? "  (template)" : n.locked ? "  (locked)" : "",
  }));
  const width = rows.reduce((w, r) => Math.max(w, r.title.length), 0);
  return rows.map((r) => `${r.title.padEnd(width)}  ${r.date}  ${r.path}${r.tag}`);
}

// What a --workspace argument may say: a root path (~ expands), or the folder
// name of exactly one registered root (so `ledge -w notes` works). A name is
// shorthand, not identity: two roots sharing a basename make it ambiguous, and
// the error lists the paths that disambiguate. workspaceMatches does the
// matching (shared with daily.workspace); only the refusals are the CLI's own.
export function resolveWorkspaceArg(value: string, registered: readonly string[], home: string = homedir()): string {
  const matches = workspaceMatches(value, registered, home);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`"${value}" names several workspaces — use a path: ${matches.join(", ")}`);
  if (registered.length === 0) throw new Error("no workspaces registered yet — open the app once first");
  throw new Error(`not a workspace: ${value} — known: ${registered.map((r) => tildify(r, home)).join(", ")}`);
}

// --- the verbs ---------------------------------------------------------------

const USAGE = `ledge — notes from the shell

usage:
  ledge                        open the Ledge app
  ledge <title|path>           open the app AT that note (\`open\` spelled out
                               reaches a note whose title is a verb here)
  ledge ls [--all]             list notes (scoped to the workspace and folder
                               containing cwd)
  ledge cat <title|path>       print a note's markdown
  ledge search <query...>      full-text search; prints path:line: match
  ledge tags [tag]             list tags (#name + note count), or the notes
                               bearing one; prints path:line: match
  ledge today                  create-or-open today's daily note, in the app
  ledge new [title...]         create a note (body read from piped stdin)
         --template <note>     instantiate that note's text as the body
                               ({{date}}, {{time}}, {{yesterday}}, ... substituted)
         -f <folder>           create it in that folder, made if it is new
  ledge append [title...]      append to a note; no title = the current note
         -m <text>             the text to append (or pipe it on stdin)
         --heading <h>         append at the end of that heading's section
  ledge workspaces             list workspace roots
  ledge mcp                    serve the Ledge MCP server on stdio
  ledge install [dir]          put a \`ledge\` shim on your PATH
  ledge help                   this text

flags:
  -w, --workspace <root>       scope to one workspace (path or folder name)
  -f, --folder <folder>        ls/search/tags: only that folder and below;
                               new/today: create the note there;
                               cat/append: which of two same-titled notes
  -a, --all                    ls/search: ignore the cwd workspace, go wide
  --json                       machine-readable output`;

/** The process seams, injected so cli.fs.test.ts can run verbs in-process. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Piped stdin, whole; null on a TTY (nothing piped). */
  stdin(): Promise<string | null>;
  cwd(): string;
  /** Launch or activate the app (`open -b`). Injected with the rest: a test
   * driving the verbs must never actually launch Ledge. False = not opened. */
  openApp(): Promise<boolean>;
}

// Dispatch into a tool by name, the same seam mcpTools.fs.test.ts uses. A
// missing name is a programmer error (the verb table drifted from the tool
// list), so it throws plainly rather than reporting a user mistake.
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const t = ledgeTools.find((x) => x.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t.handler(args);
}

// cat and append name a note by one argument. A ".md" suffix means a path,
// resolved against the caller's cwd. Anything else is a title, the preferred
// rename-proof address, so an ambiguous argument is read as a title.
//
// The `folder` argument narrows which note a title resolves to, and it is the
// explicit -f only, never the cwd's folder. Scoping a listing by where the
// caller stands is the shell contract. Scoping an address by it is not:
// `cd projects` would then stop `ledge cat` from reaching a note one level up,
// which loses an address rather than disambiguating one.
function targetArgs(
  arg: string | null,
  cwd: string,
  scope: string | null,
  folder: string | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = scope !== null ? { workspace: scope } : {};
  if (folder !== undefined) base["folder"] = folder;
  if (arg === null) return base; // no target: the handlers fall back to $LEDGE_NOTE
  return /\.md$/i.test(arg) ? { ...base, path: resolve(cwd, arg) } : { ...base, title: arg };
}

async function openApp(io: CliIo): Promise<number> {
  if (await io.openApp()) return 0;
  io.err(`ledge: could not open the app (bundle ${BUNDLE_ID}) — is Ledge installed? (macOS only)`);
  return 1;
}

// The handlers' error guidance names MCP tools ("try list_notes"), so this
// rewrites those names as CLI verbs. Substring replacement, not a second
// catalog: the messages stay single-sourced in mcpTools.ts.
function humanize(msg: string): string {
  return msg
    .replace(/\blist_notes\b/g, "`ledge ls`")
    .replace(/\bsearch_notes\b/g, "`ledge search`")
    .replace(/\blist_workspaces\b/g, "`ledge workspaces`")
    .replace(/\bread_note\b/g, "`ledge cat`")
    .replace(/\bcreate_note\b/g, "`ledge new`")
    .replace(/\bappend_note\b/g, "`ledge append`")
    .replace(/\bdaily_note\b/g, "`ledge today`");
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseCliArgs(argv);
  if ("error" in parsed) {
    io.err(`ledge: ${parsed.error} (ledge help for usage)`);
    return 2;
  }
  const { verb, positionals, flags } = parsed;
  if (flags.help || verb === "help") {
    io.out(USAGE);
    return 0;
  }
  if (verb === "") return openApp(io);
  if (verb === "mcp") {
    // Exactly mcp.ts's main: load once so a misconfigured launch says so
    // immediately, then serve stdin until the client hangs up.
    await loadWorkspaces();
    console.error("[mcp] ledge server on stdio");
    await serve(ledgeTools);
    return 0;
  }
  if (verb === "install") {
    try {
      const arg = positionals.join(" ");
      const dir =
        arg === ""
          ? null
          : resolve(io.cwd(), arg === "~" ? homedir() : arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg);
      const res = await installShim({
        execPath: process.execPath,
        entryPath: CLI_ENTRY,
        pathVar: process.env["PATH"] ?? "",
        dir,
      });
      io.out(res.path);
      if (!res.onPath) {
        io.err(`ledge: ${dirname(res.path)} is not on your PATH — add: export PATH="${dirname(res.path)}:$PATH"`);
      }
      return 0;
    } catch (err) {
      io.err(`ledge: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  try {
    await loadWorkspaces();
    const here = rootContaining(io.cwd());
    const scope = flags.workspace !== undefined ? resolveWorkspaceArg(flags.workspace, roots()) : null;
    // --folder wins. Naming a workspace or going wide means the whole of it.
    // Otherwise it is the directory the caller stands in. "" is no folder.
    const folder = flags.folder ?? (scope !== null || flags.all ? "" : cwdFolder(io.cwd(), here));
    const inFolder = (args: Record<string, unknown>): Record<string, unknown> =>
      folder === "" ? args : { ...args, folder };
    // The cwd deixis: fold "here" into the env chain the handlers already
    // honor. The finally below restores it. runCli must leave the process as
    // it found it, or in-process tests leak one verb's cwd into the next.
    const savedWs = process.env["LEDGE_WORKSPACE"];
    if (here !== null) process.env["LEDGE_WORKSPACE"] = here;
    try {
      switch (verb) {
        case "ls": {
          const ws = scope ?? (flags.all ? null : here);
          const notes = await tool("list_notes", inFolder(ws !== null ? { workspace: ws } : {}));
          if (flags.json) {
            io.out(JSON.stringify(notes, null, 2));
            return 0;
          }
          if (notes.length === 0) {
            io.err(ws !== null ? `no notes in ${tildify(folder === "" ? ws : join(ws, folder))}` : "no notes");
            return 0;
          }
          for (const line of formatNoteList(notes)) io.out(line);
          return 0;
        }
        case "cat": {
          const arg = positionals.join(" ");
          if (arg === "" && !process.env["LEDGE_NOTE"]) {
            io.err("ledge: cat needs a title or a path (ledge ls shows both)");
            return 2;
          }
          const n = await tool("read_note", targetArgs(arg === "" ? null : arg, io.cwd(), scope, flags.folder));
          if (flags.json) io.out(JSON.stringify(n, null, 2));
          else io.out((n.text as string).replace(/\n$/, ""));
          return 0;
        }
        case "search": {
          const query = positionals.join(" ");
          if (query.trim() === "") {
            io.err("ledge: search needs a query");
            return 2;
          }
          const ws = scope ?? (flags.all ? null : here);
          const res = await tool("search_notes", inFolder(ws !== null ? { query, workspace: ws } : { query }));
          if (flags.json) {
            io.out(JSON.stringify(res, null, 2));
            return res.hits.length > 0 ? 0 : 1;
          }
          for (const h of res.hits) io.out(`${hitPath(h.path, io.cwd())}:${h.line}: ${h.snippet}`);
          if (res.truncated) io.err(`ledge: more matches than shown — narrow the query`);
          if (res.lockedNotesSkipped) io.err(`ledge: ${res.lockedNotesSkipped} locked note(s) not searched`);
          return res.hits.length > 0 ? 0 : 1; // grep's contract: no match is exit 1
        }
        case "tags": {
          // Bare: the directory. With a tag: its occurrences, grep-shaped
          // like search (path:line: text, hitless = exit 1). Scoping rides
          // the same chain as ls/search: -w, else the cwd workspace, --all
          // goes wide.
          const arg = positionals.join(" ");
          const ws = scope ?? (flags.all ? null : here);
          const base: Record<string, unknown> = inFolder(ws !== null ? { workspace: ws } : {});
          if (arg === "") {
            const res = await tool("tags", base);
            if (flags.json) {
              io.out(JSON.stringify(res, null, 2));
              return 0;
            }
            if (res.tags.length === 0) {
              io.err(ws !== null ? `no tags in ${tildify(folder === "" ? ws : join(ws, folder))}` : "no tags");
              return 0;
            }
            const width = res.tags.reduce((w: number, t: { tag: string }) => Math.max(w, t.tag.length + 1), 0);
            for (const t of res.tags) io.out(`${`#${t.tag}`.padEnd(width)}  ${t.count}`);
            return 0;
          }
          const res = await tool("tags", { ...base, tag: arg });
          if (flags.json) {
            io.out(JSON.stringify(res, null, 2));
            return res.hits.length > 0 ? 0 : 1;
          }
          for (const h of res.hits) io.out(`${hitPath(h.path, io.cwd())}:${h.line}: ${h.context}`);
          if (res.truncated) io.err(`ledge: more matches than shown`);
          if (res.lockedNoteBodiesSkipped) io.err(`ledge: ${res.lockedNoteBodiesSkipped} locked note bodies not scanned`);
          return res.hits.length > 0 ? 0 : 1; // grep's contract, like search
        }
        case "new": {
          const title = positionals.join(" ");
          const body = (await io.stdin())?.replace(/\s+$/u, "") ?? "";
          if (flags.template !== undefined) {
            // The template supplies the body, so a piped body would be a
            // second body with no obvious merge order. This branch refuses it
            // rather than folding the two together.
            if (body !== "") {
              io.err("ledge: --template is the note's body — don't pipe one too");
              return 2;
            }
            if (title === "") {
              io.err("ledge: new --template needs a title for the new note");
              return 2;
            }
            const args: Record<string, unknown> = inFolder({ template: flags.template, title });
            if (scope !== null) args["workspace"] = scope;
            const n = await tool("create_note", args);
            if (flags.json) io.out(JSON.stringify(n, null, 2));
            else io.out(n.path);
            return 0;
          }
          if (title === "" && body === "") {
            io.err("ledge: new needs a title, piped stdin, or both");
            return 2;
          }
          const text = title !== "" ? `# ${title}\n` + (body !== "" ? `\n${body}\n` : "") : `${body}\n`;
          const n = await tool("create_note", inFolder(scope !== null ? { text, workspace: scope } : { text }));
          if (flags.json) io.out(JSON.stringify(n, null, 2));
          else io.out(n.path); // the path alone: `$EDITOR $(ledge new x)` should just work
          return 0;
        }
        case "today": {
          // Create or open today's note, then land the app on it. The path
          // goes to stdout first, like `new`, so the verb stays scriptable.
          // The folder comes from -f only, never from the cwd: today's note
          // is identified by its date, so where it lives stays the same every
          // day instead of moving with wherever the caller runs it from.
          const args: Record<string, unknown> = scope !== null ? { workspace: scope } : {};
          if (flags.folder !== undefined) args["folder"] = flags.folder;
          const n = await tool("daily_note", args);
          if (flags.json) io.out(JSON.stringify(n, null, 2));
          else io.out(n.path);
          await writeOpenRequest(n.path as string);
          return openApp(io);
        }
        case "append": {
          const arg = positionals.join(" ");
          const text = flags.message ?? (await io.stdin());
          if (text === null || text.trim() === "") {
            io.err("ledge: append needs text — pass -m or pipe stdin");
            return 2;
          }
          const args: Record<string, unknown> = { ...targetArgs(arg === "" ? null : arg, io.cwd(), scope, flags.folder), text };
          if (flags.heading !== undefined) args["heading"] = flags.heading;
          const n = await tool("append_note", args);
          if (flags.json) io.out(JSON.stringify(n, null, 2));
          // Say which note the tie-break picked: resolution is fuzzy enough
          // (env fallback, cross-workspace titles) that silence would hide a
          // miss until the user next opens the wrong note.
          else io.out(`appended to "${n.title}" (${tildify(n.path as string)})`);
          if (n.divergedTo) io.err(`ledge: a concurrent edit was moved to the trash: ${tildify(n.divergedTo as string)}`);
          return 0;
        }
        case "workspaces":
        case "ws": {
          const list = await tool("list_workspaces", {});
          if (flags.json) io.out(JSON.stringify(list, null, 2));
          else for (const w of list) io.out(`${tildify(w.root)}  ${w.kind}${w.available ? "" : "  (unavailable)"}`);
          return 0;
        }
        // `ledge <title>`: anything that is not a verb is a note to open in
        // the app. The CLI resolves the title in this process (same store,
        // same deixis as cat), writes the request file, then launches or
        // activates the app, which consumes it (bun/openRequest.ts). `open`
        // spelled out is the escape hatch for a note titled like a verb.
        case "open":
        default: {
          const words = verb === "open" ? positionals : [verb, ...positionals];
          const arg = words.join(" ");
          if (arg === "") return openApp(io); // bare `ledge open`
          // resolveNoteForOpen, not read_note: opening the app at a note is
          // navigation, so a locked title still resolves. The app lands on
          // its own unlock flow, and no note body crosses this seam.
          const n = await resolveNoteForOpen(targetArgs(arg, io.cwd(), scope, flags.folder));
          await writeOpenRequest(n.path);
          return openApp(io);
        }
      }
    } finally {
      if (here !== null) {
        if (savedWs === undefined) delete process.env["LEDGE_WORKSPACE"];
        else process.env["LEDGE_WORKSPACE"] = savedWs;
      }
    }
  } catch (err) {
    io.err(`ledge: ${humanize(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

if (import.meta.main) {
  const io: CliIo = {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
    stdin: async () => (process.stdin.isTTY ? null : await Bun.stdin.text()),
    cwd: () => process.cwd(),
    openApp: async () => {
      if (process.platform !== "darwin") return false;
      const proc = Bun.spawn({ cmd: ["open", "-b", BUNDLE_ID], stdout: "ignore", stderr: "ignore" });
      return (await proc.exited) === 0;
    },
  };
  process.exit(await runCli(process.argv.slice(2), io));
}
