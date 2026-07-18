// The MCP read tools against a real filesystem: what an agent actually gets.
// The interesting decisions are the ones an agent would trip over — title
// resolution across workspaces (newest wins), the registry re-read that keeps
// a long-lived server honest about workspaces attached mid-session, and the
// guards holding for paths an agent invents.
//
// Same scratch-home discipline as notes.fs.test.ts: the preload pointed
// APP_HOME at a temp dir before anything imported, and the guard re-checks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { APP_HOME, WORKSPACES_PATH, createManaged, loadWorkspaces } from "./workspaces";
import { createNote } from "./notes";
import { ledgeTools } from "./mcpTools";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

// Dispatch straight into a tool's handler: the JSON-RPC framing around it is
// mcp.test.ts's subject, not this file's.
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const tool = ledgeTools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.handler(args);
}

let ROOT = "";
let OTHER = "";

// Pin a note's mtime so "newest first" assertions are deterministic instead
// of racing the clock's resolution.
async function ageTo(path: string, ms: number): Promise<void> {
  await utimes(path, new Date(ms), new Date(ms));
}

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  ROOT = await createManaged("Notes");
  OTHER = await createManaged("Other");
});

describe("list_workspaces", () => {
  test("reflects the registry, kinds and availability included", async () => {
    const out = await call("list_workspaces");
    expect(out).toEqual([
      { root: ROOT, kind: "managed", available: true },
      { root: OTHER, kind: "managed", available: true },
    ]);
  });

  test("re-reads the registry per call — a workspace attached mid-session appears without a restart", async () => {
    // The app (a different process, from this server's point of view) writes
    // the registry file; only a per-call reload can see it.
    const extra = await mkdtemp(join(tmpdir(), "ledge-extra-"));
    await writeFile(WORKSPACES_PATH, JSON.stringify({ version: 1, roots: [ROOT, OTHER, extra] }));
    const out = await call("list_workspaces");
    expect(out.map((w: { root: string }) => w.root)).toEqual([ROOT, OTHER, resolve(extra)]);
    await rm(extra, { recursive: true, force: true });
  });
});

describe("list_notes", () => {
  test("merges every workspace newest first; scoping narrows to one", async () => {
    const a = await createNote(ROOT, "# Alpha\n");
    const b = await createNote(OTHER, "# Beta\n");
    const c = await createNote(ROOT, "# Gamma\n");
    await ageTo(a.path, 1_000_000);
    await ageTo(b.path, 3_000_000);
    await ageTo(c.path, 2_000_000);
    const all = await call("list_notes");
    expect(all.map((n: { title: string }) => n.title)).toEqual(["Beta", "Gamma", "Alpha"]);
    expect(all[0]).toEqual({ path: b.path, title: "Beta", workspace: OTHER, modified: new Date(3_000_000).toISOString() });
    const scoped = await call("list_notes", { workspace: ROOT });
    expect(scoped.map((n: { title: string }) => n.title)).toEqual(["Gamma", "Alpha"]);
  });

  test("an unregistered workspace argument is refused", async () => {
    expect(call("list_notes", { workspace: "/etc" })).rejects.toThrow("not a registered workspace root");
  });
});

describe("read_note", () => {
  test("by title, case-insensitively, with the text in full", async () => {
    const n = await createNote(ROOT, "# Shipping Notes\n\nhello agent");
    const out = await call("read_note", { title: "shipping notes" });
    expect(out.path).toBe(n.path);
    expect(out.workspace).toBe(ROOT);
    expect(out.title).toBe("Shipping Notes");
    expect(out.text).toBe("# Shipping Notes\n\nhello agent");
  });

  test("an ambiguous title resolves to the newest note, wikilink-style", async () => {
    const a = await createNote(ROOT, "# Plan\nold");
    const b = await createNote(OTHER, "# Plan\nnew");
    await ageTo(a.path, 1_000_000);
    await ageTo(b.path, 2_000_000);
    expect((await call("read_note", { title: "Plan" })).text).toBe("# Plan\nnew");
    // ...unless the workspace narrows it.
    expect((await call("read_note", { title: "Plan", workspace: ROOT })).text).toBe("# Plan\nold");
  });

  test("by path, for paths other tools handed back", async () => {
    const n = await createNote(ROOT, "# Direct\nbody");
    expect((await call("read_note", { path: n.path })).text).toBe("# Direct\nbody");
  });

  test("a near-miss title is an error, never the nearest note", async () => {
    await createNote(ROOT, "# Alpha\n");
    expect(call("read_note", { title: "Alphas" })).rejects.toThrow('no note titled "Alphas"');
  });

  test("the path guards hold against an agent-invented path", async () => {
    expect(call("read_note", { path: join(ROOT, "..", "..", "secrets.md") })).rejects.toThrow(
      "outside every workspace root",
    );
    expect(call("read_note", { path: join(ROOT, "settings.json") })).rejects.toThrow("not a note path");
  });

});

// The no-argument default: "the note I am sitting in". Ledge stamps
// LEDGE_NOTE into every note shell's spawn; the agent CLI inherits it and so
// does this server, spawned by the agent. These tests drive the same fallback
// through the server's own process env — saved and restored around each, so
// the suite behaves the same however it was launched.
describe("the current-note default (LEDGE_NOTE)", () => {
  const HAD = Object.hasOwn(process.env, "LEDGE_NOTE");
  const OLD = process.env["LEDGE_NOTE"];
  afterEach(() => {
    if (HAD) process.env["LEDGE_NOTE"] = OLD;
    else delete process.env["LEDGE_NOTE"];
  });

  test("no arguments reads the note the terminal belongs to", async () => {
    const n = await createNote(ROOT, "# Current\n\nright here");
    process.env["LEDGE_NOTE"] = n.path;
    const out = await call("read_note", {});
    expect(out.path).toBe(n.path);
    expect(out.text).toContain("right here");
  });

  test("backlinks with no arguments targets the current note too", async () => {
    const n = await createNote(ROOT, "# Current\n");
    await createNote(ROOT, "# Pointer\n[[Current]]");
    process.env["LEDGE_NOTE"] = n.path;
    const out = await call("backlinks", {});
    expect(out.backlinks.map((b: { title: string }) => b.title)).toEqual(["Pointer"]);
  });

  test("explicit arguments beat the environment", async () => {
    const cur = await createNote(ROOT, "# Current\n");
    await createNote(ROOT, "# Other\nelsewhere");
    process.env["LEDGE_NOTE"] = cur.path;
    expect((await call("read_note", { title: "Other" })).text).toContain("elsewhere");
  });

  test("a stale LEDGE_NOTE (the note renamed itself) says to use the title", async () => {
    process.env["LEDGE_NOTE"] = join(ROOT, "moved-on.md");
    expect(call("read_note", {})).rejects.toThrow("address it by title");
  });

  test("outside any note terminal, no arguments is an error that says where the default comes from", async () => {
    delete process.env["LEDGE_NOTE"];
    expect(call("read_note", {})).rejects.toThrow("LEDGE_NOTE");
  });
});

describe("search_notes", () => {
  test("finds lines across workspaces, tagged with theirs", async () => {
    await createNote(ROOT, "# One\nthe walrus sleeps");
    await createNote(OTHER, "# Two\nno walrus here either");
    const out = await call("search_notes", { query: "walrus" });
    expect(out.truncated).toBe(false);
    expect(out.hits.map((h: { title: string }) => h.title).sort()).toEqual(["One", "Two"]);
    const one = out.hits.find((h: { title: string }) => h.title === "One");
    expect(one.line).toBe(2);
    expect(one.snippet).toBe("the walrus sleeps");
    expect(one.workspace).toBe(ROOT);
  });

  test("scoping and the empty query both behave", async () => {
    await createNote(ROOT, "# One\nfindme");
    await createNote(OTHER, "# Two\nfindme");
    const out = await call("search_notes", { query: "findme", workspace: OTHER });
    expect(out.hits.map((h: { workspace: string }) => h.workspace)).toEqual([OTHER]);
    expect(call("search_notes", { query: "  " })).rejects.toThrow("non-empty query");
  });
});

describe("backlinks", () => {
  test("finds linking notes with line and context; fences and other workspaces do not count", async () => {
    const target = await createNote(ROOT, "# Target\n");
    const linker = await createNote(ROOT, "# Linker\n\nsee [[Target]] for details");
    await createNote(ROOT, "# Folded\n\nalso [[target]]");
    await createNote(ROOT, "# Fenced\n\n```\n[[Target]]\n```");
    await createNote(ROOT, "# Unrelated\n\n[[Someone Else]]");
    // Wikilinks are workspace-scoped: a note elsewhere naming the same title
    // is not a backlink of THIS note.
    await createNote(OTHER, "# Elsewhere\n\n[[Target]]");
    const out = await call("backlinks", { title: "Target" });
    expect(out.target.path).toBe(target.path);
    expect(out.backlinks.map((b: { title: string }) => b.title).sort()).toEqual(["Folded", "Linker"]);
    const hit = out.backlinks.find((b: { path: string }) => b.path === linker.path);
    expect(hit.line).toBe(3);
    expect(hit.context).toBe("see [[Target]] for details");
  });

  test("a note is not linked from itself", async () => {
    await createNote(ROOT, "# Loop\n\nme again: [[Loop]]");
    expect((await call("backlinks", { title: "Loop" })).backlinks).toEqual([]);
  });

  test("the target can be a path too", async () => {
    const target = await createNote(ROOT, "# By Path\n");
    await createNote(ROOT, "# Pointer\n[[By Path]]");
    const out = await call("backlinks", { path: target.path });
    expect(out.backlinks.map((b: { title: string }) => b.title)).toEqual(["Pointer"]);
  });
});
