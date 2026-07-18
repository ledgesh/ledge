// The MCP dispatcher's protocol decisions, against fake tools: what gets a
// reply, what gets an error, and how tool results and failures are framed.
// The real tools run against a real filesystem in mcpTools.fs.test.ts; the
// spawned-process seam (stdio framing end to end) is mcp.stdio.fs.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { createDispatcher, type McpTool } from "./mcp";

const echo: McpTool = {
  name: "echo",
  description: "echoes its arguments",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
  handler: async (args) => ({ got: args["value"] ?? null }),
};

const boom: McpTool = {
  name: "boom",
  description: "always fails",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    throw new Error("no such note");
  },
};

const handle = createDispatcher([echo, boom]);

async function send(msg: unknown): Promise<Record<string, unknown> | null> {
  const res = await handle(JSON.stringify(msg));
  return res === null ? null : (JSON.parse(res) as Record<string, unknown>);
}

function req(id: number, method: string, params?: unknown): Record<string, unknown> {
  return params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
}

describe("lifecycle", () => {
  test("initialize echoes a protocol version we support", async () => {
    const res = await send(req(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} }));
    const result = res?.["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2025-03-26");
    expect(result["capabilities"]).toEqual({ tools: {} });
    expect((result["serverInfo"] as Record<string, unknown>)["name"]).toBe("ledge");
  });

  test("an unknown protocol version gets our latest counter-offered", async () => {
    const res = await send(req(1, "initialize", { protocolVersion: "9999-01-01" }));
    expect((res?.["result"] as Record<string, unknown>)["protocolVersion"]).toBe("2025-06-18");
  });

  test("the initialized notification (no id) gets no reply", async () => {
    expect(await send({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  test("ping pongs", async () => {
    expect((await send(req(7, "ping")))?.["result"]).toEqual({});
  });
});

// The initialize instructions are the deixis lever: launched from a note's
// terminal, the server TELLS the agent which note "this note" is, instead of
// hoping it discovers the no-argument fallback in a tool description.
describe("instructions", () => {
  const SAVED = new Map<string, string | undefined>(
    ["LEDGE_NOTE", "LEDGE_WORKSPACE", "LEDGE_PROMPT_BLOCK"].map((k) => [
      k,
      Object.hasOwn(process.env, k) ? process.env[k] : undefined,
    ]),
  );
  afterEach(() => {
    for (const [k, v] of SAVED) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function initInstructions(): Promise<string> {
    const res = await send(req(1, "initialize", { protocolVersion: "2025-06-18" }));
    return (res?.["result"] as Record<string, unknown>)["instructions"] as string;
  }

  test("launched from a note's terminal, they name the note AND its workspace outright", async () => {
    process.env["LEDGE_NOTE"] = "/ws/current.md";
    process.env["LEDGE_WORKSPACE"] = "/ws";
    const text = await initInstructions();
    expect(text).toContain("/ws/current.md");
    expect(text).toContain("NO arguments");
    expect(text).toContain('"this workspace"');
    expect(text).toContain("(workspace: /ws)");
  });

  test("a note without a workspace fact still names the note, and claims nothing about 'here'", async () => {
    process.env["LEDGE_NOTE"] = "/ws/current.md";
    delete process.env["LEDGE_WORKSPACE"];
    const text = await initInstructions();
    expect(text).toContain("/ws/current.md");
    expect(text).not.toContain("this workspace");
  });

  test("launched anywhere else, they say notes must be named", async () => {
    delete process.env["LEDGE_NOTE"];
    delete process.env["LEDGE_WORKSPACE"];
    const text = await initInstructions();
    expect(text).not.toContain("this session was launched from");
    expect(text).toContain("named explicitly");
  });

  test("a prompt-block run is told it is one-shot: act, don't ask", async () => {
    // Print mode has nobody on the other end; without this the model ends
    // with "let me know if…" aimed at a closed pipe.
    process.env["LEDGE_NOTE"] = "/ws/current.md";
    process.env["LEDGE_PROMPT_BLOCK"] = "1";
    const text = await initInstructions();
    expect(text).toContain("ONE-SHOT");
    expect(text).toContain("cannot reply");
  });

  test("interactive sessions get no one-shot warning", async () => {
    process.env["LEDGE_NOTE"] = "/ws/current.md";
    delete process.env["LEDGE_PROMPT_BLOCK"];
    const text = await initInstructions();
    expect(text).not.toContain("ONE-SHOT");
  });
});

describe("tools", () => {
  test("tools/list advertises name, description, and schema", async () => {
    const res = await send(req(2, "tools/list"));
    const tools = (res?.["result"] as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t["name"])).toEqual(["echo", "boom"]);
    expect(tools[0]!["description"]).toBe("echoes its arguments");
    expect(tools[0]!["inputSchema"]).toEqual(echo.inputSchema);
  });

  test("tools/call runs the handler and frames the result as text content", async () => {
    const res = await send(req(3, "tools/call", { name: "echo", arguments: { value: "hi" } }));
    const result = res?.["result"] as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ got: "hi" });
  });

  test("missing arguments default to an empty object", async () => {
    const res = await send(req(4, "tools/call", { name: "echo" }));
    const result = res?.["result"] as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toEqual({ got: null });
  });

  test("a throwing handler is an isError RESULT the agent can read, not a protocol error", async () => {
    const res = await send(req(5, "tools/call", { name: "boom", arguments: {} }));
    expect(res?.["error"]).toBeUndefined();
    const result = res?.["result"] as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("no such note");
  });

  test("an unknown tool is invalid params", async () => {
    const res = await send(req(6, "tools/call", { name: "nope", arguments: {} }));
    expect((res?.["error"] as Record<string, unknown>)["code"]).toBe(-32602);
  });
});

describe("framing", () => {
  test("a blank line is ignored", async () => {
    expect(await handle("   ")).toBeNull();
  });

  test("unparseable input is a parse error with a null id", async () => {
    const res = JSON.parse((await handle("{nope"))!) as Record<string, unknown>;
    expect((res["error"] as Record<string, unknown>)["code"]).toBe(-32700);
    expect(res["id"]).toBeNull();
  });

  test("an unknown method on a request errors; as a notification it is dropped", async () => {
    const res = await send(req(8, "resources/list"));
    expect((res?.["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    expect(await send({ jsonrpc: "2.0", method: "resources/updated" })).toBeNull();
  });

  test("a request with an id but no method is invalid", async () => {
    const res = await send({ jsonrpc: "2.0", id: 9 });
    expect((res?.["error"] as Record<string, unknown>)["code"]).toBe(-32600);
  });

  test("string ids ride through untouched", async () => {
    const res = await send({ jsonrpc: "2.0", id: "abc-1", method: "ping" });
    expect(res?.["id"]).toBe("abc-1");
  });
});
