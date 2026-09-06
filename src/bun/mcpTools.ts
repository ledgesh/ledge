// The MCP server's tools: what an agent may read from the notes, and the
// writes it may make. Every tool routes through bun/notes.ts, so the registry
// and assertNote guards gate agents the way they gate the webview, and a
// write gets the store's invariants: uniqueName's H1-slug filenames, which an
// agent neither picks nor clobbers, writeNote's baseMtimeMs guard, and the
// watcher that shows the app the result as an external edit (architecture.md
// §1).
//
// `settings` is the one tool that names no note. It reads the user's
// settings.jsonc, so an agent answers "why is my python block using the wrong
// python" from their configuration instead of guessing. It never writes, for
// the reason bun/settings.ts gives at inspectSettings.
//
// Notes are addressed by title first, the rename-proof choice wikilinks made
// (shared/wikilinks.ts). Filenames follow the H1, so a path an agent
// remembered last session may be stale while the title still resolves. Paths
// still work (every listing tool returns them), and the same resolveWikiTitle
// decides both ends' answers.
import { resolve } from "node:path";
import { folderScopeOf, notesUnder } from "../shared/folders";
import type { NoteMeta } from "../shared/rpc-schema";
import { MAX_HITS } from "../shared/search";
import { headingOf, labelOf } from "../shared/slug";
import { appendToNote, headingsOf, resolveWikiTitle } from "../shared/wikilinks";
import { normalizeTag } from "../shared/tags";
import type { McpTool } from "./mcp";
import { backlinksTo, createNote, listNotes, notesTagged, readNote, searchNotes, tagsIn, writeNote } from "./notes";
import { assertRegisteredRoot, availableRoots, listWorkspaceRoots, loadWorkspaces, rootContaining, roots, writableRoots } from "./workspaces";
import { createFromTemplate, openDaily, resolveConfiguredWorkspace } from "./daily";
import { inspectSettings, loadSettings } from "./settings";
import type { Settings } from "../shared/settings";

// Agents read timestamps, not epoch millis.
function iso(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString();
}

// A created note's folder, for the response. Present only when the note is in
// one, matching NoteMeta and list_notes' rows. The response reports it even
// when the caller named the folder: a `folder` naming an ignored directory is
// refused rather than silently relocated (bun/notes.ts ensureFolder), and a
// note created with no folder lands at the top level.
function folderOut(meta: NoteMeta): { folder?: string } {
  return meta.folder ? { folder: meta.folder } : {};
}

interface Located extends NoteMeta {
  workspace: string;
}

// Every note an agent may see, newest first: across all available workspaces,
// or scoped to one. resolveWikiTitle's tie rule assumes that order, so an
// ambiguous title resolves to the most recently touched note, as a wikilink
// would in its own workspace. With no workspace named, one that fails to
// list is skipped (the boot fetch's stance); a named one's failure throws.
async function notesIn(workspace: unknown, folder: unknown = null): Promise<Located[]> {
  const roots = typeof workspace === "string" && workspace !== "" ? [assertRegisteredRoot(workspace)] : availableRoots();
  const scope = folderScopeOf(folder);
  const out: Located[] = [];
  for (const root of roots) {
    try {
      for (const n of notesUnder(await listNotes(root), scope)) out.push({ ...n, workspace: root });
    } catch (err) {
      if (typeof workspace === "string" && workspace !== "") throw err;
      console.error("[mcp] skipping unlistable workspace", root, err);
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// The refusal every content tool shares: a locked note's body never reaches
// an agent, whatever state the app's vault is in. Agent surfaces are what
// note locking exists to block (locking.md §8). read_note, append_note,
// edit_note and backlinks all resolve through locate(), so refusing here
// refuses in all four. The message points at list_notes, which flags them.
function refuseLocked(title: string): never {
  throw new Error(`"${title}" is locked; its body is not available to agents (locked notes are the user's private notes — list_notes flags them)`);
}

// The note a {title, path, workspace} triple names, with its text. A title
// resolves across every workspace unless one is named; a path only has to
// pass the guards. With no arguments, $LEDGE_NOTE names the note: a note
// shell's spawn stamps it (bun/spawnParams.ts stampSessionFacts), and the
// agent CLI and this server inherit it (architecture.md §2). A rename after
// that spawn leaves the path stale, so the error says to use the title.
async function locate(args: Record<string, unknown>, opts: { forOpen?: boolean } = {}): Promise<Located & { text: string }> {
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
    // `file.locked` and not `held`: the flag refuses even when the app's
    // vault is unlocked and file.text is real plaintext. forOpen skips the
    // refusal because resolveNoteForOpen drops the text: pointing the app at
    // a locked note navigates to it without disclosing the body.
    if (file.locked && !opts.forOpen) refuseLocked(labelOf(headingOf(file.text), p));
    return {
      path: p,
      workspace: rootContaining(p)!,
      title: labelOf(headingOf(file.text), p),
      mtimeMs: file.mtimeMs,
      text: file.text,
    };
  }
  if (typeof title === "string" && title.trim() !== "") {
    // The current workspace breaks ties, the way the editor does: a
    // [[wikilink]] resolves within its own note's workspace, so an agent
    // launched from a note agrees with it when the same title exists
    // elsewhere. An explicit workspace argument is narrower and wins already.
    // A stale $LEDGE_WORKSPACE, or a title only found elsewhere, costs
    // nothing: the global pass below decides.
    let meta: Located | null = null;
    const envWs = process.env["LEDGE_WORKSPACE"];
    if (envWs && !(typeof args["workspace"] === "string" && args["workspace"] !== "")) {
      try {
        meta = resolveWikiTitle(title, await notesIn(envWs, args["folder"]));
      } catch {
        meta = null;
      }
    }
    meta ??= resolveWikiTitle(title, await notesIn(args["workspace"], args["folder"]));
    if (!meta) {
      const scope = folderScopeOf(args["folder"]);
      throw new Error(
        `no note titled "${title}"${scope === "" ? "" : ` in ${scope}`} — titles match case-insensitively but exactly; try list_notes or search_notes`,
      );
    }
    if (meta.locked && !opts.forOpen) refuseLocked(meta.title);
    const file = await readNote(meta.path);
    if (file === null) throw new Error(`note "${title}" vanished mid-read; try again`);
    if (file.locked && !opts.forOpen) refuseLocked(meta.title); // locked between listing and read
    return { ...meta, text: file.text, mtimeMs: file.mtimeMs };
  }
  throw new Error("give either a title or a path");
}

/**
 * Resolve a note for the app to open (`ledge <title>` / `ledge open`). This
 * is the one CLI resolution that must reach locked notes: opening one lands
 * on the app's own unlock flow. No body crosses the seam. The text is
 * dropped here, and the CLI process has no unlocked vault to read one with.
 * It lives in this module so the CLI takes its semantics from the handler
 * layer instead of restating them (architecture.md §1).
 */
export async function resolveNoteForOpen(args: Record<string, unknown>): Promise<{ path: string; title: string; workspace: string }> {
  const n = await locate(args, { forOpen: true });
  return { path: n.path, title: n.title, workspace: n.workspace };
}

// The workspace a created note lands in. An explicit argument wins. With
// none, $LEDGE_WORKSPACE names the current one (a note shell's spawn stamps
// it beside $LEDGE_NOTE); failing that, a lone workspace is unambiguous.
// Past all three the error names what would fix it. The variable can name a
// root detached since the spawn, so that case gets its own message instead
// of the bare guard message for a path the agent never supplied.
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
  // Writable roots only: the built-in docs root is registered and readable,
  // but "the sole workspace" must mean the sole one a note can land in.
  const roots = writableRoots();
  if (roots.length === 1) return roots[0]!;
  throw new Error(
    roots.length === 0
      ? "no workspace is available to create in (unmounted volume? list_workspaces shows what Ledge knows)"
      : "several workspaces exist — name one (list_workspaces shows them), or call from a shell in a Ledge note's terminal, where LEDGE_WORKSPACE names the current one",
  );
}

// Where today's note lives: an explicit argument, then the daily.workspace
// setting, then targetWorkspace's chain. Only this tool reads the setting;
// create_note's chain is unchanged. When targetWorkspace finds no workspace,
// this function rethrows its error with the daily.workspace hint appended.
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

// And where inside it: an explicit argument, then the daily.folder setting,
// then the top level. create_note's folder has no such standing fallback. The
// setting exists because ⌘J creates a note without asking the user where to
// put it.
function dailyFolder(args: Record<string, unknown>, settings: Settings): string | null {
  if (typeof args["folder"] === "string") return args["folder"];
  return settings.daily.folder || null;
}

const TITLE_OR_PATH_PROPS = {
  title: {
    type: "string",
    description:
      "The note's title (its H1). Case-insensitive exact match; survives renames. Preferred. A title several notes share resolves in the current session's workspace first, then newest-first across all of them.",
  },
  path: { type: "string", description: "A note path previously returned by list_notes, search_notes, or backlinks." },
  workspace: { type: "string", description: "Restrict title resolution to one workspace root." },
  folder: {
    type: "string",
    description:
      "Restrict title resolution to one folder and its subfolders — how to say WHICH of two notes that share a title, as list_notes reports in each row's `folder`. Ignored when addressing by `path`.",
  },
} as const;

// Two folder arguments with different jobs. On a listing tool a folder selects
// notes that are already there; on a creating tool it places a new one. Only
// the second reaches the filesystem, through ensureFolder's guards. The first
// is a filter, so a folder holding no notes matches nothing.
const FOLDER_SCOPE_PROP = {
  type: "string",
  description:
    "Restrict to notes in this folder and its subfolders — a workspace-relative path with forward slashes, like `projects/api`, as list_notes reports in each row's `folder`. Omit for every folder.",
} as const;

const FOLDER_PLACE_PROP = {
  type: "string",
  description:
    "The folder to create the note in — a workspace-relative path with forward slashes, like `projects/api`, created if it does not exist. Omit to create at the top level of the workspace, which is where the user's own New Note puts one.",
} as const;

const CURRENT_NOTE_HINT =
  " With NO arguments, targets the current note — the one whose terminal this session was launched from (Ledge sets LEDGE_NOTE in every note's shells).";

export const ledgeTools: McpTool[] = [
  {
    name: "list_workspaces",
    description:
      "List the workspaces Ledge knows: each is a folder of Markdown notes. Returns the root path (the `workspace` argument other tools take), the kind (a Ledge-managed folder, an attached external one, or `docs` — Ledge's built-in documentation, readable like any workspace but refusing every write), and whether it is on disk right now.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      await loadWorkspaces();
      return listWorkspaceRoots();
    },
  },
  {
    name: "list_notes",
    description:
      "List notes — title, path, workspace, folder, last modified — newest first, across every available workspace or scoped to one, or to one folder inside it. A row's `folder` is where the note sits inside its workspace (absent at the top level); two notes may share a title, and the folder is what tells them apart. A note whose frontmatter declares `template: true` (or `template: daily`) carries that value in its row: those are the user's note templates, the ones create_note's `template` argument is usually pointed at — and the `daily` one is what daily_note instantiates. A row flagged `locked: true` is one of the user's private locked notes: its body cannot be read, searched, or edited by agents.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "A workspace root from list_workspaces." },
        folder: FOLDER_SCOPE_PROP,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      await loadWorkspaces();
      const notes = await notesIn(args["workspace"], args["folder"]);
      return notes.map((n) => ({
        path: n.path,
        title: n.title,
        workspace: n.workspace,
        modified: iso(n.mtimeMs),
        // Where the note sits, so an agent can tell two same-titled notes
        // apart without doing path arithmetic against the workspace root.
        // Absent for a note at the top level, as on NoteMeta itself.
        ...(n.folder ? { folder: n.folder } : {}),
        // Present only when the note is marked, as on the meta: most rows
        // carry nothing, and a daily template's row carries template: "daily".
        ...(n.template ? { template: n.template } : {}),
        // Agents plan against listings, so a note whose body will refuse
        // must say so in the row (locking.md §8).
        ...(n.locked ? { locked: true } : {}),
      }));
    },
  },
  {
    name: "read_note",
    description:
      "Read a note's full Markdown text. Address it by title (preferred — titles survive renames) or by a path from another tool's result. Locked notes refuse: their bodies are the user's private content, not available to agents (list_notes flags them)." +
      CURRENT_NOTE_HINT,
    inputSchema: { type: "object", properties: TITLE_OR_PATH_PROPS, additionalProperties: false },
    handler: async (args) => {
      await loadWorkspaces();
      const n = await locate(args);
      return {
        path: n.path,
        workspace: n.workspace,
        ...(n.folder ? { folder: n.folder } : {}),
        title: n.title,
        modified: iso(n.mtimeMs),
        text: n.text,
      };
    },
  },
  {
    name: "search_notes",
    description:
      "Full-text search over note bodies: the whole query as ONE case-insensitive substring (no fuzzy matching). Scopes to a workspace, or to one folder inside it. Returns matching lines with 1-based line numbers, newest notes first, capped — `truncated` says whether anything was cut. Locked notes are never searched; `lockedNotesSkipped` says how many the answer therefore does not cover.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The substring to find." },
        workspace: { type: "string", description: "A workspace root from list_workspaces." },
        folder: FOLDER_SCOPE_PROP,
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
      // searchNotes takes the folder scope, rather than this handler
      // filtering the hits it returns. Reading stops at the hit cap, so notes
      // outside the folder would otherwise spend a budget the folder's own
      // matches never get.
      const folder = folderScopeOf(args["folder"]);
      const all: Array<{ path: string; title: string; workspace: string; mtimeMs: number; line: number; snippet: string }> = [];
      let lockedSkipped = 0;
      for (const root of roots) {
        try {
          const res = await searchNotes(root, query, folder);
          lockedSkipped += res.lockedSkipped;
          for (const h of res.hits) {
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
        // An agent has to know its answer does not cover the user's locked
        // notes (locking.md §8). Present only when non-zero, so an answer
        // over a corpus with no locked notes keeps its old shape.
        ...(lockedSkipped > 0 ? { lockedNotesSkipped: lockedSkipped } : {}),
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
      // The scan is backlinksTo (bun/notes.ts), the same definition the app's
      // Backlinks panel reads over RPC. It is workspace-scoped because
      // wikilinks are. Its hits carry more than this response returns (a
      // NoteMeta's mtimeMs, and `raw`, which the panel's reveal re-finds on
      // the line). The mapping below returns path, title, line and context,
      // and drops the rest, so what the panel needs stays out of the response.
      const scan = await backlinksTo(target.path);
      const backlinks = scan.backlinks.map(({ path, title, line, context }) => ({
        path,
        title,
        line,
        context,
      }));
      return {
        target: { path: target.path, title: target.title, workspace: target.workspace },
        backlinks,
        ...(scan.lockedSkipped > 0 ? { lockedNotesSkipped: scan.lockedSkipped } : {}),
      };
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
        folder: FOLDER_SCOPE_PROP,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      await loadWorkspaces();
      const workspace = args["workspace"];
      const roots =
        typeof workspace === "string" && workspace !== "" ? [assertRegisteredRoot(workspace)] : availableRoots();
      const tag = args["tag"];
      const folder = folderScopeOf(args["folder"]);
      // The scans are tagsIn/notesTagged (bun/notes.ts), the same definitions
      // the app's Tags panel reads over RPC, so agents and the UI cannot
      // disagree about what tags exist. The cross-workspace merge and the
      // failure stance match search_notes: with no workspace named, one that
      // fails to scan is skipped; a named one's failure throws to the caller.
      if (typeof tag === "string" && normalizeTag(tag) !== "") {
        const all: Array<{ path: string; title: string; workspace: string; mtimeMs: number; line: number; context: string }> = [];
        let lockedSkipped = 0;
        for (const root of roots) {
          try {
            const res = await notesTagged(root, tag, folder);
            lockedSkipped += res.lockedSkipped;
            for (const h of res.hits) {
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
          // Locked notes still contribute their frontmatter tags (the
          // plaintext head). The count says their body hashtags went
          // unscanned.
          ...(lockedSkipped > 0 ? { lockedNoteBodiesSkipped: lockedSkipped } : {}),
        };
      }
      // Directory mode. Counts sum across workspaces (their note sets are
      // disjoint); identity folds case, first-seen spelling wins the merge.
      const merged = new Map<string, { tag: string; count: number }>();
      let lockedSkipped = 0;
      for (const root of roots) {
        try {
          const res = await tagsIn(root, folder);
          lockedSkipped += res.lockedSkipped;
          for (const t of res.tags) {
            const entry = merged.get(normalizeTag(t.tag));
            if (entry) entry.count += t.count;
            else merged.set(normalizeTag(t.tag), { tag: t.tag, count: t.count });
          }
        } catch (err) {
          if (typeof workspace === "string" && workspace !== "") throw err;
          console.error("[mcp] skipping unscannable workspace", root, err);
        }
      }
      return {
        tags: [...merged.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
        ...(lockedSkipped > 0 ? { lockedNoteBodiesSkipped: lockedSkipped } : {}),
      };
    },
  },
  {
    name: "settings",
    description:
      "Read the user's Ledge settings: the raw text of their settings.jsonc, comments and all. The file IS Ledge's settings UI (they edit it in the app with ⌘,), and its comments document every knob, so one call gives both what they have configured and what the knobs mean. `problems` lists values Ledge would reject at the next launch, empty when the file is clean. This tool is READ-ONLY and has no writing sibling: to change a setting, tell the user the exact line to add or edit, and that Ledge applies settings at the next launch, not live. For how a feature works rather than how it is configured, search the built-in manual (the `docs` workspace from list_workspaces).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    // No workspace argument and no registry lookup: settings are global
    // rather than per workspace, and this reads the server's file in the app
    // home (architecture.md §6). It is the only tool here that names no note.
    handler: async () => inspectSettings(),
  },
  {
    name: "create_note",
    description:
      "Create a new note. Start the text with an H1 (`# Title`) — the filename is derived from it, and the title is how every other tool (and the user's [[wikilinks]]) will address the note; without one it is created as untitled. Names never clobber: a duplicate title gets a numbered file. Instead of `text`, give `template` (the title of an existing note) plus `title`: the template's text becomes the new note's body, with {{date}}, {{time}}, {{title}}, {{yesterday}}, and {{tomorrow}} substituted and its H1 replaced by `title`. With no `workspace`, the note lands in the current session's workspace (Ledge sets LEDGE_WORKSPACE in every note's shells), or in the only workspace when just one exists. With no `folder` it lands at the top level of that workspace; there is no tool for moving a note afterwards, so name the folder when creating.",
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
        folder: FOLDER_PLACE_PROP,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      await loadWorkspaces();
      const template = args["template"];
      // The `folder` argument is not validated here: ensureFolder owns the
      // one name a caller gets to choose (bun/notes.ts folderPathOf,
      // architecture.md §3). A check in front of it would be a second guard
      // that could disagree with the first.
      const folder = typeof args["folder"] === "string" ? args["folder"] : null;
      if (typeof template === "string" && template.trim() !== "") {
        if (typeof args["text"] === "string" && args["text"].trim() !== "") {
          throw new Error("give either `text` or `template`, not both — the template is the note's body");
        }
        const title = args["title"];
        if (typeof title !== "string" || title.trim() === "") {
          throw new Error("creating from a template needs a `title` for the new note");
        }
        const root = targetWorkspace(args);
        const meta = await createFromTemplate(root, template.trim(), title.trim(), folder);
        return { path: meta.path, title: meta.title, workspace: root, ...folderOut(meta), modified: iso(meta.mtimeMs) };
      }
      const text = args["text"];
      if (typeof text !== "string" || text.trim() === "") {
        throw new Error("give the note's text (start it with `# Title` — the title is how the note will be addressed)");
      }
      const root = targetWorkspace(args);
      const meta = await createNote(root, text, folder);
      return { path: meta.path, title: meta.title, workspace: root, ...folderOut(meta), modified: iso(meta.mtimeMs) };
    },
  },
  {
    name: "daily_note",
    description:
      "Create or open today's daily note: one note per LOCAL calendar day, titled YYYY-MM-DD. Idempotent — if a note bearing today's date as its title exists in the target workspace it is returned (`created: false`), never duplicated. A missing one is created from the target workspace's own note whose frontmatter says `template: daily` when one exists ({{tokens}} substituted, like create_note's `template`; strictly per-workspace — another workspace's daily template is never borrowed), else as a bare dated note. The workspace: an explicit argument wins, then the `daily.workspace` setting, then the current session's workspace (LEDGE_WORKSPACE), then the only workspace when just one exists. The folder inside it: an explicit argument, then the `daily.folder` setting, then the top level.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "A workspace root from list_workspaces." },
        folder: {
          ...FOLDER_PLACE_PROP,
          description:
            "The folder to create today's note in, if it does not exist yet. Overrides the user's `daily.folder` setting, which is otherwise where it goes. Ignored when today's note already exists: it is found by its title anywhere in the workspace, so whoever opens it first decides where it lives.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      await loadWorkspaces();
      // This handler reads the settings per call, not at module load,
      // matching loadWorkspaces: an edited setting reaches the next call
      // without restarting the server.
      const settings = await loadSettings();
      const root = dailyWorkspace(args, settings);
      const { meta, created } = await openDaily(root, dailyFolder(args, settings));
      return { path: meta.path, title: meta.title, workspace: root, ...folderOut(meta), created, modified: iso(meta.mtimeMs) };
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
      // Notes end in a newline. This only fires when the edit removed the
      // note's last one: old_text reached the end of the file, and the
      // replacement went in without it.
      if (!edited.endsWith("\n")) edited += "\n";
      const res = await writeNote(n.path, edited, n.mtimeMs);
      const out: Record<string, unknown> = {
        path: n.path,
        // Recomputed from the edited text, the way locate() computed it: the
        // edit may have rewritten the H1, and the old title would then name
        // the wrong note.
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
