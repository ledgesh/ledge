// The Ledge CLI: notes from a shell prompt. `ledge` is an entry point beside
// the app and the MCP server (architecture.md §1), built the same way the MCP
// server is: a separate process that reuses the bun-side store — and it goes
// one step further, dispatching through the SAME McpTool handlers agents
// call. That reuse is the point, not a shortcut: title resolution, workspace
// deixis, H1-slug naming, and the divergence guard have one definition, so
// `ledge append` and an agent's append_note cannot drift apart, and the
// running app perceives a CLI write exactly as it perceives an agent's — an
// ordinary external edit, through its watcher.
//
// Deixis: inside a note's terminal the environment already names "here"
// ($LEDGE_NOTE / $LEDGE_WORKSPACE, architecture.md §2) and the handlers honor
// it. The CLI adds the one shell-native fact the server never had: the
// working directory. A cwd inside a registered root IS "here" — `ledge new`
// in a project workspace creates there, ls/search scope there — expressed by
// setting $LEDGE_WORKSPACE for the handler call rather than by a parallel
// resolution rule, so cwd rides the existing precedence (an explicit
// --workspace still outranks it, exactly as it outranks the env).
//
// Output discipline: results go to stdout (raw text for `cat`, one row per
// line for lists, the handler's JSON under --json), everything conversational
// — errors, confirmations, truncation notes — to stderr, so a pipe never has
// to strip chatter. Exit codes are conventional: 0 ok, 1 failure (including
// a search with no hits, grep's contract), 2 usage.
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { serve } from "./mcp";
import { ledgeTools } from "./mcpTools";
import { installShim, tildify } from "./cliShim";
import { writeOpenRequest } from "./openRequest";
import { loadWorkspaces, rootContaining, roots, workspaceMatches } from "./workspaces";

export { tildify }; // display formatting; defined in cliShim.ts so the app's install handler shares it

/** The app's bundle identifier — how `open -b` finds it without a path. */
export const BUNDLE_ID = "sh.ledge.app";

// This module's own location: what an installed shim execs. Resolves to
// src/bun/cli.ts in a checkout and Resources/app/bun/cli.js in the bundle.
const CLI_ENTRY = import.meta.path;

// --- pure helpers (unit-tested in cli.test.ts) -------------------------------

export interface CliFlags {
  workspace?: string;
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

// Hand-rolled argv parsing (§8: a flag loop is less code than a library's
// config). Flags may sit anywhere; `--` ends flag parsing so a title that
// starts with a dash stays reachable.
export function parseCliArgs(argv: readonly string[]): ParsedCli | { error: string } {
  const flags: CliFlags = { json: false, all: false, help: false };
  const positionals: string[] = [];
  const valued: Record<string, "workspace" | "heading" | "message" | "template"> = {
    "--workspace": "workspace",
    "-w": "workspace",
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

// A search hit's path the way a shell user reads one: relative when the hit
// is under the cwd (the grep experience inside a workspace), ~-shortened
// otherwise. Never "..", which reads as a riddle in a result list.
export function hitPath(p: string, cwd: string, home: string = homedir()): string {
  const rel = relative(cwd, p);
  return rel === "" || rel.startsWith("..") ? tildify(p, home) : rel;
}

/** ls rows: title column padded, date, then the variable-width path last. */
export function formatNoteList(
  notes: ReadonlyArray<{ title: string; path: string; modified: string; template?: true | "daily" }>,
  home: string = homedir(),
): string[] {
  const rows = notes.map((n) => ({
    title: n.title,
    date: n.modified.slice(0, 10),
    path: tildify(n.path, home),
    // The `template:` frontmatter marker, surfaced where the notes are
    // listed — the same discoverability move as the app's ⌥⌘N picker. A
    // trailing tag, not a column: most rows have nothing to say.
    tag: n.template === "daily" ? "  (daily template)" : n.template ? "  (template)" : "",
  }));
  const width = rows.reduce((w, r) => Math.max(w, r.title.length), 0);
  return rows.map((r) => `${r.title.padEnd(width)}  ${r.date}  ${r.path}${r.tag}`);
}

// What a --workspace argument may say: a root path (~ expands), or — for
// `ledge -w notes` convenience — the folder name of exactly one registered
// root. Names are shorthand, not identity: two roots sharing a basename make
// the name ambiguous, and the error lists the paths that would disambiguate.
// The match itself is workspaceMatches (shared with the daily.workspace
// setting); only the refusals are the CLI's own.
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
  ledge ls [--all]             list notes (scoped to the workspace containing cwd)
  ledge cat <title|path>       print a note's markdown
  ledge search <query...>      full-text search; prints path:line: match
  ledge tags [tag]             list tags (#name + note count), or the notes
                               bearing one; prints path:line: match
  ledge today                  create-or-open today's daily note, in the app
  ledge new [title...]         create a note (body read from piped stdin)
         --template <note>     instantiate that note's text as the body
                               ({{date}}, {{time}}, {{yesterday}}, ... substituted)
  ledge append [title...]      append to a note; no title = the current note
         -m <text>             the text to append (or pipe it on stdin)
         --heading <h>         append at the end of that heading's section
  ledge workspaces             list workspace roots
  ledge mcp                    serve the Ledge MCP server on stdio
  ledge install [dir]          put a \`ledge\` shim on your PATH
  ledge help                   this text

flags:
  -w, --workspace <root>       scope to one workspace (path or folder name)
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

// Dispatch into a tool by name — the exact seam mcpTools.fs.test.ts uses. A
// missing name is a programmer error (the verb table drifted from the tool
// list), so it throws plainly rather than pretending to be user input.
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const t = ledgeTools.find((x) => x.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t.handler(args);
}

// cat/append name a note by one argument. A ".md" suffix says path (resolved
// against the caller's cwd, the shell contract); anything else is a title —
// the preferred, rename-proof address, so the ambiguity tilts its way.
function targetArgs(arg: string | null, cwd: string, scope: string | null): Record<string, unknown> {
  const base: Record<string, unknown> = scope !== null ? { workspace: scope } : {};
  if (arg === null) return base; // no target: the handlers fall back to $LEDGE_NOTE
  return /\.md$/i.test(arg) ? { ...base, path: resolve(cwd, arg) } : { ...base, title: arg };
}

async function openApp(io: CliIo): Promise<number> {
  if (await io.openApp()) return 0;
  io.err(`ledge: could not open the app (bundle ${BUNDLE_ID}) — is Ledge installed? (macOS only)`);
  return 1;
}

// The handlers' error guidance speaks MCP ("try list_notes"); a shell user
// gets the same advice in their own dialect. Substring replacement, not a
// reworded catalog: the messages themselves stay single-sourced in mcpTools.
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
    // The cwd deixis: fold "here" into the env chain the handlers already
    // honor. Restored on the way out — runCli must leave the process as it
    // found it, or in-process tests would leak one verb's cwd into the next.
    const savedWs = process.env["LEDGE_WORKSPACE"];
    if (here !== null) process.env["LEDGE_WORKSPACE"] = here;
    try {
      switch (verb) {
        case "ls": {
          const ws = scope ?? (flags.all ? null : here);
          const notes = await tool("list_notes", ws !== null ? { workspace: ws } : {});
          if (flags.json) {
            io.out(JSON.stringify(notes, null, 2));
            return 0;
          }
          if (notes.length === 0) {
            io.err(ws !== null ? `no notes in ${tildify(ws)}` : "no notes");
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
          const n = await tool("read_note", targetArgs(arg === "" ? null : arg, io.cwd(), scope));
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
          const res = await tool("search_notes", ws !== null ? { query, workspace: ws } : { query });
          if (flags.json) {
            io.out(JSON.stringify(res, null, 2));
            return res.hits.length > 0 ? 0 : 1;
          }
          for (const h of res.hits) io.out(`${hitPath(h.path, io.cwd())}:${h.line}: ${h.snippet}`);
          if (res.truncated) io.err(`ledge: more matches than shown — narrow the query`);
          return res.hits.length > 0 ? 0 : 1; // grep's contract: no match is exit 1
        }
        case "tags": {
          // Bare: the directory. With a tag: its occurrences, grep-shaped
          // like search (path:line: text, hitless = exit 1). Scoping rides
          // the same chain as ls/search: -w, else the cwd workspace, --all
          // goes wide.
          const arg = positionals.join(" ");
          const ws = scope ?? (flags.all ? null : here);
          const base: Record<string, unknown> = ws !== null ? { workspace: ws } : {};
          if (arg === "") {
            const res = await tool("tags", base);
            if (flags.json) {
              io.out(JSON.stringify(res, null, 2));
              return 0;
            }
            if (res.tags.length === 0) {
              io.err(ws !== null ? `no tags in ${tildify(ws)}` : "no tags");
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
          return res.hits.length > 0 ? 0 : 1; // grep's contract, like search
        }
        case "new": {
          const title = positionals.join(" ");
          const body = (await io.stdin())?.replace(/\s+$/u, "") ?? "";
          if (flags.template !== undefined) {
            // The template IS the body; a piped one would be a second body
            // with no principled merge order, so it is refused, not folded.
            if (body !== "") {
              io.err("ledge: --template is the note's body — don't pipe one too");
              return 2;
            }
            if (title === "") {
              io.err("ledge: new --template needs a title for the new note");
              return 2;
            }
            const args: Record<string, unknown> = { template: flags.template, title };
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
          const n = await tool("create_note", scope !== null ? { text, workspace: scope } : { text });
          if (flags.json) io.out(JSON.stringify(n, null, 2));
          else io.out(n.path); // the path alone: `$EDITOR $(ledge new x)` should just work
          return 0;
        }
        case "today": {
          // Create-or-open today's note, then land in the app on it — the
          // whole point is one motion from anywhere. Path to stdout first
          // (the `new` contract: scriptable), the open ride-along after.
          const n = await tool("daily_note", scope !== null ? { workspace: scope } : {});
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
          const args: Record<string, unknown> = { ...targetArgs(arg === "" ? null : arg, io.cwd(), scope), text };
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
        // `ledge <title>` — anything that is not a verb is a note to open in
        // the app. The CLI resolves the title HERE (same store, same deixis
        // as cat), writes the request file, and launches/activates the app,
        // which consumes the request (bun/openRequest.ts). `open` spelled out
        // is the escape hatch for a note titled like a verb.
        case "open":
        default: {
          const words = verb === "open" ? positionals : [verb, ...positionals];
          const arg = words.join(" ");
          if (arg === "") return openApp(io); // bare `ledge open`
          const n = await tool("read_note", targetArgs(arg, io.cwd(), scope));
          await writeOpenRequest(n.path as string);
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
