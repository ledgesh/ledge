// The spawned-process seam: this test runs `bun src/bun/mcp.ts` as its own
// process and talks JSON-RPC over its real stdin and stdout, as an agent CLI
// does with an MCP server. mcp.test.ts covers the dispatcher and
// mcpTools.fs.test.ts the tools. Only this file covers the assembly:
//   - import.meta.main fires
//   - the registry loads from the env the client set
//   - each reply is one JSON line
//   - nothing else reaches stdout, where a stray log line would corrupt every
//     client's stream
//
// The child gets its own scratch home, built by hand. It computes its own
// APP_HOME at import time from LEDGE_NOTES_ROOT (workspaces.ts), so the test
// passes that variable to point it at the hand-built home instead of the
// preload's scratch root. The .workspaces.json written below is the same file
// the app writes at its own launch, so the server reads a registry that looks
// like one the app left behind.
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "ledge-mcp-stdio-"));
const WS = join(HOME, "ws");

afterAll(async () => {
  await rm(HOME, { recursive: true, force: true });
});

test("a full client session: initialize, list, call — one JSON line per reply", async () => {
  await mkdir(WS, { recursive: true });
  await writeFile(join(HOME, ".workspaces.json"), JSON.stringify({ version: 1, roots: [WS] }));
  await writeFile(join(WS, "hello-agent.md"), "# Hello Agent\n\nsecret word: xyzzy\n");

  const proc = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "mcp.ts")],
    env: { ...process.env, LEDGE_NOTES_ROOT: HOME },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_note", arguments: { title: "hello agent" } } },
  ];
  proc.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);

  const replies = out.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  // Three requests, three replies, nothing else on stdout. The notification
  // got no answer, and no log line leaked into the stream.
  expect(replies.map((r) => r["id"])).toEqual([1, 2, 3]);

  const init = replies[0]!["result"] as Record<string, unknown>;
  expect((init["serverInfo"] as Record<string, unknown>)["name"]).toBe("ledge");

  const tools = (replies[1]!["result"] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  expect(tools).toEqual(["list_workspaces", "list_notes", "read_note", "search_notes", "backlinks", "tags", "settings", "create_note", "daily_note", "append_note", "edit_note"]);

  const call = replies[2]!["result"] as { content: Array<{ text: string }>; isError?: boolean };
  expect(call.isError).toBeUndefined();
  const note = JSON.parse(call.content[0]!.text) as Record<string, unknown>;
  expect(note["title"]).toBe("Hello Agent");
  expect(note["workspace"]).toBe(WS);
  expect(note["text"]).toContain("xyzzy");
});
