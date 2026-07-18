// The read tier of the MCP server: what an agent may learn from the notes.
// Every tool routes through bun/notes.ts, so the registry and assertNote
// guards gate agents exactly as they gate the webview — and the read-only
// scope is deliberate risk sequencing: agents that WRITE notes go through
// their own shell today (which the external-edit safety work made survivable),
// and write tools join this list only once the read tier has proven out.
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
import { resolveWikiTitle, wikiRefsOf } from "../shared/wikilinks";
import type { McpTool } from "./mcp";
import { listNotes, readNote, searchNotes } from "./notes";
import { assertRegisteredRoot, availableRoots, listWorkspaceRoots, loadWorkspaces, rootContaining } from "./workspaces";

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
// Exactly one of title/path must be given; title resolves across every
// workspace unless one is named, path just has to pass the guards.
async function locate(args: Record<string, unknown>): Promise<Located & { text: string }> {
  const { title, path } = args;
  if (typeof path === "string" && path !== "") {
    const file = await readNote(path); // throws for anything outside a registered root
    if (file === null) throw new Error(`no note at ${path} — it may have been renamed; try its title, or list_notes`);
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
    const meta = resolveWikiTitle(title, await notesIn(args["workspace"]));
    if (!meta) throw new Error(`no note titled "${title}" — titles match case-insensitively but exactly; try list_notes or search_notes`);
    const file = await readNote(meta.path);
    if (file === null) throw new Error(`note "${title}" vanished mid-read; try again`);
    return { ...meta, text: file.text, mtimeMs: file.mtimeMs };
  }
  throw new Error("give either a title or a path");
}

// Backlink context is one result row, not a paragraph.
const CONTEXT_MAX = 200;
function contextOf(lines: string[], line: number): string {
  const text = (lines[line - 1] ?? "").trim();
  return text.length > CONTEXT_MAX ? `${text.slice(0, CONTEXT_MAX)}…` : text;
}

const TITLE_OR_PATH_PROPS = {
  title: {
    type: "string",
    description: "The note's title (its H1). Case-insensitive exact match; survives renames. Preferred.",
  },
  path: { type: "string", description: "A note path previously returned by list_notes, search_notes, or backlinks." },
  workspace: { type: "string", description: "Restrict title resolution to one workspace root." },
} as const;

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
      "List notes — title, path, workspace, last modified — newest first, across every available workspace or scoped to one.",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string", description: "A workspace root from list_workspaces." } },
      additionalProperties: false,
    },
    handler: async (args) => {
      await loadWorkspaces();
      const notes = await notesIn(args["workspace"]);
      return notes.map((n) => ({ path: n.path, title: n.title, workspace: n.workspace, modified: iso(n.mtimeMs) }));
    },
  },
  {
    name: "read_note",
    description:
      "Read a note's full Markdown text. Address it by title (preferred — titles survive renames) or by a path from another tool's result.",
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
      "Find the notes whose [[wikilinks]] point at a given note. The target may be named by title or path; links resolve within the target's own workspace, the same way the editor resolves them.",
    inputSchema: { type: "object", properties: TITLE_OR_PATH_PROPS, additionalProperties: false },
    handler: async (args) => {
      await loadWorkspaces();
      const target = await locate(args);
      // Wikilinks are workspace-scoped (a title in one workspace cannot name
      // a note in another), so the scan is too — and resolution runs against
      // the SAME meta list the linking notes' editors would use.
      const metas = await notesIn(target.workspace);
      const backlinks: Array<{ path: string; title: string; line: number; context: string }> = [];
      for (const meta of metas) {
        if (meta.path === target.path) continue; // a note is not "linked from" itself
        const file = await readNote(meta.path);
        if (file === null) continue; // deleted mid-scan costs that note only
        const lines = file.text.split("\n");
        for (const ref of wikiRefsOf(file.text)) {
          if (resolveWikiTitle(ref.title, metas)?.path !== target.path) continue;
          backlinks.push({ path: meta.path, title: meta.title, line: ref.line, context: contextOf(lines, ref.line) });
        }
      }
      return { target: { path: target.path, title: target.title, workspace: target.workspace }, backlinks };
    },
  },
];
