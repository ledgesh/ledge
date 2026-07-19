// The MCP server's tools: what an agent may learn from the notes, plus the
// write tier that joined once the read tier proved out. Every tool routes
// through bun/notes.ts, so the registry and assertNote guards gate agents
// exactly as they gate the webview — and a write arrives with the store's
// invariants intact: create_note names files by H1 slug through uniqueName
// (an agent cannot choose a filename, let alone clobber one), append_note
// and edit_note save through writeNote's baseMtimeMs guard (a concurrent
// edit is moved to the trash, never destroyed), and the running app sees any
// of them as an ordinary external edit through its watcher — the same
// survivability story the agent's own shell already had.
//
// Notes are addressed by TITLE first — the same rename-proof choice wikilinks
// made (shared/wikilinks.ts): filenames follow the H1, so a path an agent
// remembered last session may have rotted, while the title still resolves.
// Paths still work (they come back from every listing tool), and the same
// resolveWikiTitle decides both ends' answers.
import { resolve } from "node:path";
import type { NoteMeta } from "../shared/rpc-schema";
import { MAX_HITS } from "../shared/search";
import { headingOf, labelOf } from "../shared/slug";
import { appendToNote, headingsOf, resolveWikiTitle } from "../shared/wikilinks";
import { normalizeTag } from "../shared/tags";
import type { McpTool } from "./mcp";
import { backlinksTo, createNote, listNotes, notesTagged, readNote, searchNotes, tagsIn, writeNote } from "./notes";
import { assertRegisteredRoot, availableRoots, listWorkspaceRoots, loadWorkspaces, rootContaining, roots } from "./workspaces";
import { createFromTemplate, openDaily, resolveConfiguredWorkspace } from "./daily";
import { loadSettings } from "./settings";
import type { Settings } from "../shared/settings";

// Agents read timestamps, not epoch millis.
function iso(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString();
}

interface Located extends NoteMeta {
  workspace: string;
}

// Every note an agent may see, newest first — across all available workspaces
// or scoped to one. The cross-workspace merge keeps the newest-first order
// resolveWikiTitle's tie rule assumes, so an ambiguous title resolves to the
// most recently touched note, same as a wikilink would in its own workspace.
// When no scope was asked for, a workspace that fails to list costs itself
// only (the boot fetch's stance); a NAMED workspace failing is the caller's
// answer.
async function notesIn(workspace: unknown): Promise<Located[]> {
  const roots = typeof workspace === "string" && workspace !== "" ? [assertRegisteredRoot(workspace)] : availableRoots();
  const out: Located[] = [];
  for (const root of roots) {
    try {
      for (const n of await listNotes(root)) out.push({ ...n, workspace: root });
    } catch (err) {
      if (typeof workspace === "string" && workspace !== "") throw err;
      console.error("[mcp] skipping unlistable workspace", root, err);
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// The note a {title, path, workspace} triple names, with its text in hand.
// Title resolves across every workspace unless one is named; path just has
// to pass the guards. NO arguments at all falls back to $LEDGE_NOTE — the
// deixis chain: Ledge stamps the variable into every note shell's spawn
// (bun/index.ts sessionFacts), the agent CLI launched there inherits it, and
// so does this server, spawned by the agent. "The note I am sitting in"
// then needs no argument. The env names a path, so it can go stale if the
// note renames itself after the shell spawned — the error says so, because
// the fix (address it by title) is not guessable from "not found".
async function locate(args: Record<string, unknown>): Promise<Located & { text: string }> {
  const { title } = args;
  let path = typeof args["path"] === "string" && args["path"] !== "" ? (args["path"] as string) : null;
  let fromEnv = false;
  if (path === null && !(typeof title === "string" && title.trim() !== "")) {
    const env = process.env["LEDGE_NOTE"];
    if (!env) {
      throw new Error(
        "give a title or a path — or call from a shell in a Ledge note's terminal, where LEDGE_NOTE names the current note and no argument is needed",
      );
    }
    path = env;
    fromEnv = true;
  }
  if (path !== null) {
    const file = await readNote(path); // throws for anything outside a registered root
    if (file === null) {
      throw new Error(
        fromEnv
          ? `LEDGE_NOTE names ${path}, which is gone — the note was likely renamed after its terminal opened; address it by title (list_notes shows them)`
          : `no note at ${path} — it may have been renamed; try its title, or list_notes`,
      );
    }
    const p = resolve(path);
    return {
      path: p,
      workspace: rootContaining(p)!,
      title: labelOf(headingOf(file.text), p),
      mtimeMs: file.mtimeMs,
      text: file.text,
    };
  }
  if (typeof title === "string" && title.trim() !== "") {
    // The current workspace breaks ties, the way the editor already does: a
    // [[wikilink]] in the current note resolves within its own workspace, so
    // an agent launched from that note should agree with it when the same
    // title exists elsewhere. An explicit workspace argument is a narrower
    // scope and already wins; a stale $LEDGE_WORKSPACE (or a title that only
    // exists elsewhere) costs nothing — the global pass decides as before.
    let meta: Located | null = null;
    const envWs = process.env["LEDGE_WORKSPACE"];
    if (envWs && !(typeof args["workspace"] === "string" && args["workspace"] !== "")) {
      try {
        meta = resolveWikiTitle(title, await notesIn(envWs));
      } catch {
        meta = null;
      }
    }
    meta ??= resolveWikiTitle(title, await notesIn(args["workspace"]));
    if (!meta) throw new Error(`no note titled "${title}" — titles match case-insensitively but exactly; try list_notes or search_notes`);
    const file = await readNote(meta.path);
    if (file === null) throw new Error(`note "${title}" vanished mid-read; try again`);
    return { ...meta, text: file.text, mtimeMs: file.mtimeMs };
  }
  throw new Error("give either a title or a path");
}

// The workspace a created note lands in. An explicit argument wins; with
// none, $LEDGE_WORKSPACE — stamped beside $LEDGE_NOTE into every note shell's
// spawn — means "here"; with no environment either, a sole workspace is
// unambiguous. Only past all three is it the agent's problem, and the error
// says what would fix it. The env can name a since-detached root (facts are
// spawn-time), so its failure explains itself instead of leaking the bare
// guard message for a path the agent never supplied.
function targetWorkspace(args: Record<string, unknown>): string {
  const asked = args["workspace"];
  if (typeof asked === "string" && asked !== "") return assertRegisteredRoot(asked);
  const env = process.env["LEDGE_WORKSPACE"];
  if (env) {
    try {
      return assertRegisteredRoot(env);
    } catch {
      throw new Error(
        `LEDGE_WORKSPACE names ${env}, which is no longer a registered workspace root — name one explicitly (list_workspaces shows them)`,
      );
    }
  }
  const roots = availableRoots();
  if (roots.length === 1) return roots[0]!;
  throw new Error(
    roots.length === 0
      ? "no workspace is available to create in (unmounted volume? list_workspaces shows what Ledge knows)"
      : "several workspaces exist — name one (list_workspaces shows them), or call from a shell in a Ledge note's terminal, where LEDGE_WORKSPACE names the current one",
  );
}

// Where today's note lives: an explicit ask wins, then the daily.workspace
// setting, then the ordinary deixis chain. Only the daily tool consults the
// setting — create_note keeps its existing chain untouched — and only here
// does the no-workspace error learn to mention the knob that would pin it.
function dailyWorkspace(args: Record<string, unknown>, settings: Settings): string {
  const asked = args["workspace"];
  if (typeof asked === "string" && asked !== "") return assertRegisteredRoot(asked);
  const configured = resolveConfiguredWorkspace(settings.daily.workspace, roots());
  if (configured !== null) return configured;
  try {
    return targetWorkspace(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg} — or set daily.workspace in settings.jsonc to pin where daily notes live`);
  }
}

const TITLE_OR_PATH_PROPS = {
  title: {
    type: "string",
    description:
      "The note's title (its H1). Case-insensitive exact match; survives renames. Preferred. A title several notes share resolves in the current session's workspace first, then newest-first across all of them.",
  },
  path: { type: "string", description: "A note path previously returned by list_notes, search_notes, or backlinks." },
  workspace: { type: "string", description: "Restrict title resolution to one workspace root." },
} as const;

const CURRENT_NOTE_HINT =
  " With NO arguments, targets the current note — the one whose terminal this session was launched from (Ledge sets LEDGE_NOTE in every note's shells).";

export const ledgeTools: McpTool[] = [
  {
    name: "list_workspaces",
    description:
      "List the workspaces Ledge knows: each is a folder of Markdown notes. Returns the root path (the `workspace` argument other tools take), whether Ledge manages the folder or it is an attached external one, and whether it is on disk right now.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      await loadWorkspaces();
      return listWorkspaceRoots();
    },
  },
  {
    name: "list_notes",
    description:
      "List notes — title, path, workspace, last modified — newest first, across every available workspace or scoped to one. A note whose frontmatter declares `template: true` (or `template: daily`) carries that value in its row: those are the user's note templates, the ones create_note's `template` argument is usually pointed at — and the `daily` one is what daily_note instantiates.",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string", description: "A workspace root from list_workspaces." } },
      additionalProperties: false,
    },
    handler: async (args) => {
      await loadWorkspaces();
      const notes = await notesIn(args["workspace"]);
      return notes.map((n) => ({
        path: n.path,
        title: n.title,
        workspace: n.workspace,
        modified: iso(n.mtimeMs),
        // Present-only-when-marked, like the meta itself: most rows say
        // nothing; the daily template's row says template: "daily".
        ...(n.template ? { template: n.template } : {}),
      }));
    },
  },
  {
    name: "read_note",
    description:
      "Read a note's full Markdown text. Address it by title (preferred — titles survive renames) or by a path from another tool's result." +
      CURRENT_NOTE_HINT,
    inputSchema: { type: "object", properties: TITLE_OR_PATH_PROPS, additionalProperties: false },
    handler: async (args) => {
      await loadWorkspaces();
      const n = await locate(args);
      return { path: n.path, workspace: n.workspace, title: n.title, modified: iso(n.mtimeMs), text: n.text };
    },
  },
  {
    name: "search_notes",
    description:
      "Full-text search over note bodies: the whole query as ONE case-insensitive substring (no fuzzy matching). Returns matching lines with 1-based line numbers, newest notes first, capped — `truncated` says whether anything was cut.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The substring to find." },
        workspace: { type: "string", description: "A workspace root from list_workspaces." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = args["query"];
      if (typeof query !== "string" || query.trim() === "") throw new Error("give a non-empty query");
      await loadWorkspaces();
      const workspace = args["workspace"];
      const roots =
        typeof workspace === "string" && workspace !== "" ? [assertRegisteredRoot(workspace)] : availableRoots();
      const all: Array<{ path: string; title: string; workspace: string; mtimeMs: number; line: number; snippet: string }> = [];
      for (const root of roots) {
        try {
          for (const h of await searchNotes(root, query)) {
            all.push({ path: h.path, title: h.title, workspace: root, mtimeMs: h.mtimeMs, line: h.line, snippet: h.snippet });
          }
        } catch (err) {
          if (typeof workspace === "string" && workspace !== "") throw err;
          console.error("[mcp] skipping unsearchable workspace", root, err);
        }
      }
      // Same newest-first merge as list_notes; the sort is stable, so a
      // note's own hits stay in document order.
      all.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const hits = all.slice(0, MAX_HITS);
      return {
        hits: hits.map(({ mtimeMs, ...h }) => ({ ...h, modified: iso(mtimeMs) })),
        truncated: all.length > MAX_HITS,
      };
    },
  },
  {
    name: "backlinks",
    description:
      "Find the notes whose [[wikilinks]] point at a given note. The target may be named by title or path; links resolve within the target's own workspace, the same way the editor resolves them." +
      CURRENT_NOTE_HINT,
    inputSchema: { type: "object", properties: TITLE_OR_PATH_PROPS, additionalProperties: false },
    handler: async (args) => {
      await loadWorkspaces();
      const target = await locate(args);
      // The scan is backlinksTo (bun/notes.ts) — the same definition the app's
      // Backlinks panel reads over RPC, workspace-scoped because wikilinks
      // are. Its hits carry the panel's extra fields (mtimeMs, the raw match);
      // this response keeps its original shape — agent output should not
      // churn under a UI feature.
      const backlinks = (await backlinksTo(target.path)).map(({ path, title, line, context }) => ({
        path,
        title,
        line,
        context,
      }));
      return { target: { path: target.path, title: target.title, workspace: target.workspace }, backlinks };
    },
  },
  {
    name: "tags",
    description:
      "List tags, or find the notes bearing one. Notes carry tags two ways — inline #hashtags in the body, and a `tags:` line in the note's frontmatter block (comma- or space-separated; a leading # per entry is fine) — and this tool sees both. Without `tag`: the tag directory, alphabetical, each with how many notes bear it. With `tag`: every occurrence (note, 1-based line, that line's text), newest notes first, capped — `truncated` says whether anything was cut. Tags match case-insensitively, with or without the leading #.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "A tag, with or without its leading #. Omit for the directory." },
        workspace: { type: "string", description: "A workspace root from list_workspaces." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      await loadWorkspaces();
      const workspace = args["workspace"];
      const roots =
        typeof workspace === "string" && workspace !== "" ? [assertRegisteredRoot(workspace)] : availableRoots();
      const tag = args["tag"];
      // The scans are tagsIn/notesTagged (bun/notes.ts) — the same definitions
      // the app's Tags panel reads over RPC, so agents and the UI can never
      // disagree about what tags exist. Cross-workspace merge and failure
      // stance are search_notes': unscoped, a workspace that fails to scan
      // costs itself only; a NAMED one failing is the caller's answer.
      if (typeof tag === "string" && normalizeTag(tag) !== "") {
        const all: Array<{ path: string; title: string; workspace: string; mtimeMs: number; line: number; context: string }> = [];
        for (const root of roots) {
          try {
            for (const h of await notesTagged(root, tag)) {
              all.push({ path: h.path, title: h.title, workspace: root, mtimeMs: h.mtimeMs, line: h.line, context: h.context });
            }
          } catch (err) {
            if (typeof workspace === "string" && workspace !== "") throw err;
            console.error("[mcp] skipping unscannable workspace", root, err);
          }
        }
        all.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const hits = all.slice(0, MAX_HITS);
        return {
          hits: hits.map(({ mtimeMs, ...h }) => ({ ...h, modified: iso(mtimeMs) })),
          truncated: all.length > MAX_HITS,
        };
      }
      // Directory mode. Counts sum across workspaces (their note sets are
      // disjoint); identity folds case, first-seen spelling wins the merge.
      const merged = new Map<string, { tag: string; count: number }>();
      for (const root of roots) {
        try {
          for (const t of await tagsIn(root)) {
            const entry = merged.get(normalizeTag(t.tag));
            if (entry) entry.count += t.count;
            else merged.set(normalizeTag(t.tag), { tag: t.tag, count: t.count });
          }
        } catch (err) {
          if (typeof workspace === "string" && workspace !== "") throw err;
          console.error("[mcp] skipping unscannable workspace", root, err);
        }
      }
      return { tags: [...merged.values()].sort((a, b) => a.tag.localeCompare(b.tag)) };
    },
  },
  {
    name: "create_note",
    description:
      "Create a new note. Start the text with an H1 (`# Title`) — the filename is derived from it, and the title is how every other tool (and the user's [[wikilinks]]) will address the note; without one it is created as untitled. Names never clobber: a duplicate title gets a numbered file. Instead of `text`, give `template` (the title of an existing note) plus `title`: the template's text becomes the new note's body, with {{date}}, {{time}}, {{title}}, {{yesterday}}, and {{tomorrow}} substituted and its H1 replaced by `title`. With no `workspace`, the note lands in the current session's workspace (Ledge sets LEDGE_WORKSPACE in every note's shells), or in the only workspace when just one exists.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note's full Markdown text, H1 first. Required unless `template` is given." },
        template: {
          type: "string",
          description:
            "The title of an existing note to instantiate as this note's body, instead of `text`. Any note works; the user's designated templates are the notes list_notes flags `template: true` (their frontmatter carries that marker, which instantiation strips from the new note).",
        },
        title: { type: "string", description: "The new note's title, when creating from `template`." },
        workspace: { type: "string", description: "A workspace root from list_workspaces." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      await loadWorkspaces();
      const template = args["template"];
      if (typeof template === "string" && template.trim() !== "") {
        if (typeof args["text"] === "string" && args["text"].trim() !== "") {
          throw new Error("give either `text` or `template`, not both — the template is the note's body");
        }
        const title = args["title"];
        if (typeof title !== "string" || title.trim() === "") {
          throw new Error("creating from a template needs a `title` for the new note");
        }
        const root = targetWorkspace(args);
        const meta = await createFromTemplate(root, template.trim(), title.trim());
        return { path: meta.path, title: meta.title, workspace: root, modified: iso(meta.mtimeMs) };
      }
      const text = args["text"];
      if (typeof text !== "string" || text.trim() === "") {
        throw new Error("give the note's text (start it with `# Title` — the title is how the note will be addressed)");
      }
      const root = targetWorkspace(args);
      const meta = await createNote(root, text);
      return { path: meta.path, title: meta.title, workspace: root, modified: iso(meta.mtimeMs) };
    },
  },
  {
    name: "daily_note",
    description:
      "Create or open today's daily note: one note per LOCAL calendar day, titled YYYY-MM-DD. Idempotent — if a note bearing today's date as its title exists in the target workspace it is returned (`created: false`), never duplicated. A missing one is created from the target workspace's own note whose frontmatter says `template: daily` when one exists ({{tokens}} substituted, like create_note's `template`; strictly per-workspace — another workspace's daily template is never borrowed), else as a bare dated note. The workspace: an explicit argument wins, then the `daily.workspace` setting, then the current session's workspace (LEDGE_WORKSPACE), then the only workspace when just one exists.",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string", description: "A workspace root from list_workspaces." } },
      additionalProperties: false,
    },
    handler: async (args) => {
      await loadWorkspaces();
      // Per call, not at module load: matching loadWorkspaces' stance, so an
      // edited knob reaches the next call without restarting the server.
      const settings = await loadSettings();
      const root = dailyWorkspace(args, settings);
      const { meta, created } = await openDaily(root);
      return { path: meta.path, title: meta.title, workspace: root, created, modified: iso(meta.mtimeMs) };
    },
  },
  {
    name: "append_note",
    description:
      "Append Markdown to an existing note, as a new block separated by one blank line. Address the note by title (preferred) or path; with neither, appends to the current note — the one whose terminal this session was launched from. Give `heading` to append at the END of that heading's section (before the next same-or-shallower heading) instead of the end of the note — prefer this when the note has a matching section, so additions land with their kin. Either way, a run of ```prompt blocks at the very end stays at the end: those are the note's controls, and the addition lands above them, with the rest of the content. The note's H1 (and so its title and filename) is untouched. If someone else saved the note mid-append, their version is preserved in the workspace's trash and `divergedTo` names where.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The Markdown to append." },
        heading: {
          type: "string",
          description:
            "A heading in the note (case-insensitive, without the #s). The text is appended at the end of that heading's section.",
        },
        ...TITLE_OR_PATH_PROPS,
      },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const text = args["text"];
      if (typeof text !== "string" || text.trim() === "") throw new Error("give the text to append");
      await loadWorkspaces();
      const n = await locate(args);
      // Block semantics live in appendToNote (shared/wikilinks.ts): one blank
      // line each side, trailing ```prompt blocks stay at the end. Leading
      // blank lines in the addition would double the separator, so they go;
      // first-line indentation stays (it can be meaningful Markdown).
      const addition = text.replace(/^(?:[ \t]*\n)+/u, "").replace(/\s+$/u, "");
      const heading =
        typeof args["heading"] === "string" && args["heading"].trim() !== "" ? (args["heading"] as string) : null;
      const joined = appendToNote(n.text, addition, heading);
      if (joined === null) {
        const have = headingsOf(n.text).map((h) => h.text);
        throw new Error(
          `no heading "${heading}" in "${n.title}" — ` +
            (have.length ? `its headings are: ${have.join(", ")}` : "it has no headings") +
            "; omit `heading` to append at the end",
        );
      }
      // baseMtimeMs is the version locate() just read: a foreign write landing
      // inside this handler's read-modify-write window is moved to the trash
      // by writeNote's guard, never silently lost under the append.
      const res = await writeNote(n.path, joined, n.mtimeMs);
      const out: Record<string, unknown> = { path: n.path, title: n.title, workspace: n.workspace, modified: iso(res.mtimeMs) };
      if (res.divergedTo !== null) out["divergedTo"] = res.divergedTo;
      return out;
    },
  },
  {
    name: "edit_note",
    description:
      "Revise a note by exact text replacement. `old_text` must match the note's current text exactly — whitespace and newlines included, as read_note returns it — and exactly once; include enough surrounding context to pin the spot, or set `replace_all` to change every occurrence. An empty `new_text` deletes the match. This tool changes what is already there; to add new content, prefer append_note (it places additions correctly). Unlike append_note it can touch the H1, which retitles the note — address it by the new title afterwards. Address the note by title (preferred) or path; with neither, edits the current note — the one whose terminal this session was launched from. If someone else saved the note mid-edit, their version is preserved in the workspace's trash and `divergedTo` names where.",
    inputSchema: {
      type: "object",
      properties: {
        old_text: { type: "string", description: "The exact text to replace, verbatim from the note." },
        new_text: { type: "string", description: "The replacement. Empty deletes the matched text." },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring exactly one match.",
        },
        ...TITLE_OR_PATH_PROPS,
      },
      required: ["old_text", "new_text"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const oldText = args["old_text"];
      const newText = args["new_text"];
      if (typeof oldText !== "string" || oldText === "") {
        throw new Error("give old_text — the exact text to replace (to add new content, use append_note or create_note)");
      }
      if (typeof newText !== "string") throw new Error("give new_text — the replacement (empty deletes the match)");
      if (oldText === newText) throw new Error("old_text and new_text are identical — nothing would change");
      await loadWorkspaces();
      const n = await locate(args);
      // split/join, not replaceAll: a `$&` in the replacement must stay
      // literal text, and the split counts the matches in the same pass.
      const parts = n.text.split(oldText);
      const count = parts.length - 1;
      if (count === 0) {
        throw new Error(
          `old_text not found in "${n.title}" — the match is exact, whitespace and newlines included; read_note shows the current text`,
        );
      }
      if (count > 1 && args["replace_all"] !== true) {
        throw new Error(
          `old_text appears ${count} times in "${n.title}" — include more surrounding context to make it unique, or set replace_all to change every occurrence`,
        );
      }
      let edited = parts.join(newText);
      // Notes end in a newline; only an edit that ate the note's last one
      // (old_text reaching EOF, replacement without it) trips this.
      if (!edited.endsWith("\n")) edited += "\n";
      const res = await writeNote(n.path, edited, n.mtimeMs);
      const out: Record<string, unknown> = {
        path: n.path,
        // Recomputed from the edited text, the way locate() computed it: the
        // edit may have rewritten the H1, and the old title would misaddress.
        title: labelOf(headingOf(edited), n.path),
        workspace: n.workspace,
        modified: iso(res.mtimeMs),
      };
      if (count > 1) out["replacements"] = count;
      if (res.divergedTo !== null) out["divergedTo"] = res.divergedTo;
      return out;
    },
  },
];
