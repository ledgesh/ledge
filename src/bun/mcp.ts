// The Ledge MCP server: how agents read and write the user's notes. Agent
// CLIs (Claude Code, Codex, Gemini, anything speaking MCP) spawn this file as
// a third process beside the running app. They talk JSON-RPC 2.0 over stdio,
// one message per line. Its tools route through bun/notes.ts and
// bun/workspaces.ts (mcpTools.ts). An agent's paths go through the same
// registry and assertNote guards the webview's do, so the invariants have one
// definition rather than a copy per client.
//
// Hand-rolled, not @modelcontextprotocol/sdk (architecture.md §8). A
// tools-only server needs initialize, tools/list, and tools/call, and that is
// three switch arms over newline-delimited JSON. Add the SDK if this ever
// grows resources, prompts, or server-initiated notifications.
//
// stdout belongs to the protocol. A line there that is not JSON-RPC corrupts
// the stream, so logging here and in every module this imports must go to
// stderr. console.error and console.warn do; console.log would not, and
// nothing on this import path calls it.
import { loadWorkspaces } from "./workspaces";
import { ledgeTools } from "./mcpTools";

/** One MCP tool: what tools/list advertises and tools/call dispatches to.
 * Handlers return any JSON-serializable value, which is stringified into the
 * reply's text content. They throw plain Errors for tool failures, which come
 * back as isError results the agent can read rather than protocol errors. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// Spec revisions this server is compatible with (tools have not changed
// shape across them). initialize echoes the client's version when it is one
// of these, and otherwise counter-offers the latest, as the spec prescribes.
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const LATEST_PROTOCOL = "2025-06-18";

// What the client folds into the agent's context at connect time. A tool
// description is reference material the model might never read; these
// instructions sit in its working context. That makes them the deixis lever
// a tool description cannot be. The server also knows at startup whether it
// was spawned inside a note's terminal ($LEDGE_NOTE, architecture.md §2). It
// names that note here. Otherwise the model has to find read_note's
// no-argument fallback for itself.
//
// Read at initialize, not at module load: the env cannot change mid-process,
// but tests drive both env shapes through one dispatcher.
function instructions(): string {
  const note = process.env["LEDGE_NOTE"];
  const ws = process.env["LEDGE_WORKSPACE"];
  // A runnable ```prompt fence sets this marker in its command (the default
  // `prompt` interpreter in shared/settings.ts). That command runs the agent
  // in one-shot print mode. The user cannot reply. The instructions say up
  // front that a follow-up question goes unanswered.
  const oneShot = process.env["LEDGE_PROMPT_BLOCK"]
    ? " This is a ONE-SHOT run from a prompt block inside the note; the user cannot reply to your output. Never ask follow-up questions or offer options — make the sensible choice, act, and state briefly what you did."
    : "";
  const here = note
    ? `This session was launched from inside the Ledge note at ${note}${ws ? ` (workspace: ${ws})` : ""}. When the user says "this note" or "the current note", they mean that one: call read_note with NO arguments to fetch it (backlinks with no arguments targets it too; append_note with only \`text\` appends to it, and edit_note with only \`old_text\`/\`new_text\` edits it).${ws ? ` When they say "this workspace" or "here", they mean ${ws} — pass it as the \`workspace\` argument to scope a tool to it (create_note already defaults into it).` : ""}`
    : `When an agent runs inside a Ledge note's terminal, $LEDGE_NOTE names that note and read_note with no arguments reads it; this session was not launched from one, so notes must be named explicitly.`;
  return (
    "Ledge is the user's local Markdown notes app; these tools read and write their notes. " +
    "Notes are addressed by TITLE (their H1, case-insensitive) — titles survive file renames, paths may not. " +
    // Two notes may share a title, and a row's `folder` is what tells them
    // apart (notes.ts omits the field for a note at the top level). Stated
    // here rather than left to list_notes' description: the model has to know
    // to ask "which of these two" before it reads any tool schema.
    "Notes sit in FOLDERS inside their workspace — placement, not an address: two notes may share a title, and each list_notes row's `folder` is what tells them apart. The listing and searching tools take a `folder` to scope to one; create_note takes one to place a new note, and nothing moves a note afterwards. " +
    "Notes may carry tags — inline #hashtags in the body, or a frontmatter `tags:` line; the `tags` tool lists a workspace's tags, or the notes bearing one. " +
    // Ledge's own manual is a workspace of notes, so the read tools already
    // reach it. An agent that never learns it exists answers questions about
    // Ledge from its training data, which produces wrong keystrokes and
    // invented settings. Same lever as the deixis facts above: state it here
    // rather than hope the model infers it from list_workspaces' `kind`.
    'Ledge\'s own manual is a read-only workspace of notes (`kind: "docs"` from list_workspaces) and search_notes covers it: answer questions about Ledge itself — a feature, a keystroke, a setting — from those pages rather than from memory. ' +
    "The `settings` tool reads the user's settings file, comments included, when the answer depends on how they have Ledge configured. Nothing here writes it: say what to change, and that Ledge applies settings at the next launch. " +
    here +
    oneShot
  );
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Id = number | string;

function reply(id: Id, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function fail(id: Id | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One request line in, one response line out; null for notifications and
 * blank lines, which get no answer. The server is stateless and does not
 * track whether initialize happened. Refusing a tools/call from a client that
 * skipped the handshake would protect nothing: the agent's own shell can
 * already read and write these notes, and the write tools go through the
 * guarded store the app itself uses (architecture.md §2).
 */
export function createDispatcher(tools: readonly McpTool[]): (line: string) => Promise<string | null> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return async (line) => {
    if (line.trim() === "") return null;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, PARSE_ERROR, "not JSON");
    }
    if (!isRecord(msg)) return fail(null, INVALID_REQUEST, "not a JSON-RPC message");
    const id = msg["id"];
    const method = msg["method"];
    // A message with no method is a response to something this server sent
    // (it sends nothing), or it is malformed. A notification, meaning a
    // message with no id, never gets an answer, whatever its method.
    if (typeof method !== "string") {
      return typeof id === "number" || typeof id === "string" ? fail(id, INVALID_REQUEST, "no method") : null;
    }
    if (typeof id !== "number" && typeof id !== "string") return null;
    const params = isRecord(msg["params"]) ? msg["params"] : {};

    switch (method) {
      case "initialize": {
        const asked = params["protocolVersion"];
        return reply(id, {
          protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.has(asked) ? asked : LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "ledge", version: "0.0.1" },
          instructions: instructions(),
        });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      case "tools/call": {
        const tool = typeof params["name"] === "string" ? byName.get(params["name"]) : undefined;
        if (!tool) return fail(id, INVALID_PARAMS, `unknown tool: ${String(params["name"])}`);
        const args = isRecord(params["arguments"]) ? params["arguments"] : {};
        try {
          const result = await tool.handler(args);
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        } catch (err) {
          // A tool failure is a result, not a protocol error. The agent
          // reads the message and tries a different call rather than tearing
          // the connection down.
          const message = err instanceof Error ? err.message : String(err);
          return reply(id, { content: [{ type: "text", text: message }], isError: true });
        }
      }
      default:
        return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  };
}

// serve() reads stdin until it closes. The client hanging up is the shutdown
// signal, because MCP over stdio has no bye message. Lines are handled
// strictly in order: the tools are cheap, so replying out of request order
// would only make the transcript harder to read.
export async function serve(tools: readonly McpTool[]): Promise<void> {
  const handle = createDispatcher(tools);
  for await (const line of console) {
    const res = await handle(line);
    if (res !== null) process.stdout.write(res + "\n");
  }
}

if (import.meta.main) {
  // Load the registry once up front so a misconfigured launch (a wrong
  // LEDGE_NOTES_ROOT, say) reports the problem on stderr immediately. Every
  // tool that needs the registry reloads it (mcpTools.ts), so this snapshot
  // going stale does not matter.
  await loadWorkspaces();
  console.error("[mcp] ledge server on stdio");
  await serve(ledgeTools);
}
