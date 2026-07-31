// The Ledge MCP server: how agents read and write the user's notes. Agent CLIs (Claude
// Code, Codex, Gemini — anything speaking MCP) spawn this file as a THIRD
// process, entirely separate from the running app, and talk JSON-RPC 2.0 over
// stdio, one message per line. It is Bun-side code in the architectural sense
// that matters: it reuses bun/notes.ts and bun/workspaces.ts, so every path an
// agent can reach is gated by the same registry and assertNote guards the
// webview is — the invariants have one definition, not a per-client copy.
//
// Hand-rolled, not @modelcontextprotocol/sdk (architecture.md §8): a
// tools-only server needs initialize, tools/list, and tools/call — three
// switch arms over newline-delimited JSON. The SDK earns its place if this
// ever grows resources, prompts, or server-initiated notifications.
//
// stdout belongs to the protocol. Anything written there that is not a
// JSON-RPC line corrupts the stream, so logging — here and in every module
// this imports — must go to stderr (console.error/warn do; console.log would
// not, and nothing on this import path calls it).
import { loadWorkspaces } from "./workspaces";
import { ledgeTools } from "./mcpTools";

/** One MCP tool: what tools/list advertises and tools/call dispatches to.
 * Handlers return any JSON-serializable value (it is stringified into the
 * reply's text content) and throw plain Errors for tool failures — those
 * come back as isError results the agent can read, not protocol errors. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// Spec revisions this server is compatible with (tools have not changed shape
// across them). initialize echoes the client's version when we know it, else
// counter-offers the latest — the spec's prescribed dance.
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const LATEST_PROTOCOL = "2025-06-18";

// What the client folds into the agent's context at connect time. This is
// the deixis lever the per-tool descriptions cannot be: a tool description
// is reference material the model may or may not consult, while initialize
// instructions sit in its working context — and the server KNOWS at startup
// whether it was spawned from inside a note's terminal ($LEDGE_NOTE,
// architecture.md §2), so "this note" can be resolved by name up front
// instead of hoping the model discovers the no-argument fallback.
// Read at initialize, not module load: the env cannot change mid-process,
// but tests exercise both shapes through one dispatcher.
function instructions(): string {
  const note = process.env["LEDGE_NOTE"];
  const ws = process.env["LEDGE_WORKSPACE"];
  // A runnable ```prompt fence stamps this marker into its command
  // (shared/settings.ts, the default interpreter value). One-shot print mode
  // has nobody on the other end: an agent that ends its reply with "let me
  // know if…" is talking to a closed pipe, so tell it so up front.
  const oneShot = process.env["LEDGE_PROMPT_BLOCK"]
    ? " This is a ONE-SHOT run from a prompt block inside the note; the user cannot reply to your output. Never ask follow-up questions or offer options — make the sensible choice, act, and state briefly what you did."
    : "";
  const here = note
    ? `This session was launched from inside the Ledge note at ${note}${ws ? ` (workspace: ${ws})` : ""}. When the user says "this note" or "the current note", they mean that one: call read_note with NO arguments to fetch it (backlinks with no arguments targets it too; append_note with only \`text\` appends to it, and edit_note with only \`old_text\`/\`new_text\` edits it).${ws ? ` When they say "this workspace" or "here", they mean ${ws} — pass it as the \`workspace\` argument to scope a tool to it (create_note already defaults into it).` : ""}`
    : `When an agent runs inside a Ledge note's terminal, $LEDGE_NOTE names that note and read_note with no arguments reads it; this session was not launched from one, so notes must be named explicitly.`;
  return (
    "Ledge is the user's local Markdown notes app; these tools read and write their notes. " +
    "Notes are addressed by TITLE (their H1, case-insensitive) — titles survive file renames, paths may not. " +
    "Notes may carry tags — inline #hashtags in the body, or a frontmatter `tags:` line; the `tags` tool lists a workspace's tags, or the notes bearing one. " +
    // Ledge's own manual is a workspace of notes, so the read tools already
    // reach it — but an agent that never learns it exists answers questions
    // about Ledge from its training data instead, which is where wrong
    // keystrokes and invented settings come from. Same lever as the deixis
    // facts above: state it, do not hope the model infers it from
    // list_workspaces' `kind`.
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
 * One request line in, one response line out (or null: notifications and
 * blank lines get no answer). Deliberately stateless — the server does not
 * track whether initialize happened, because refusing a tools/call from a
 * client that skipped the handshake protects nothing here: every tool touches
 * only notes the agent's own shell could read and write anyway — and the
 * write tools go through the same guarded store the app itself uses.
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
    // A response to something we sent (we send nothing) — or malformed. A
    // notification (no id) never gets an answer, whatever its method.
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
          // Tool failure is a RESULT, not a protocol error: the agent should
          // read the message and try again differently, not tear down.
          const message = err instanceof Error ? err.message : String(err);
          return reply(id, { content: [{ type: "text", text: message }], isError: true });
        }
      }
      default:
        return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  };
}

// Serve stdin until it closes (the client hanging up is the shutdown signal —
// MCP stdio has no bye message). Lines are handled strictly in order: tools
// are cheap reads, and interleaving replies out of request order buys nothing
// but a harder-to-read transcript.
export async function serve(tools: readonly McpTool[]): Promise<void> {
  const handle = createDispatcher(tools);
  for await (const line of console) {
    const res = await handle(line);
    if (res !== null) process.stdout.write(res + "\n");
  }
}

if (import.meta.main) {
  // Load the registry once up front so a misconfigured launch (wrong
  // LEDGE_NOTES_ROOT, say) says so immediately on stderr; every tool call
  // re-reads it anyway (mcpTools.ts) so this snapshot never goes stale.
  await loadWorkspaces();
  console.error("[mcp] ledge server on stdio");
  await serve(ledgeTools);
}
