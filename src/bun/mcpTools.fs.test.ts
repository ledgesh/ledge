// The MCP tools against a real filesystem: what an agent actually gets, and
// what its writes actually do. The interesting decisions are the ones an
// agent would trip over — title resolution across workspaces (newest wins),
// the registry re-read that keeps a long-lived server honest about workspaces
// attached mid-session, the guards holding for paths an agent invents, and
// the write tier inheriting the store's naming and never-clobber rules.
//
// Same scratch-home discipline as notes.fs.test.ts: the preload pointed
// APP_HOME at a temp dir before anything imported, and the guard re-checks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { APP_HOME, WORKSPACES_PATH, createManaged, loadWorkspaces } from "./workspaces";
import { createNote, readNote } from "./notes";
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

// The current-workspace tie-break: an ambiguous title resolves the way the
// current note's own [[wikilinks]] would — within its workspace — before the
// global newest-first pass gets a say. Same deixis chain as LEDGE_NOTE; the
// two are stamped together.
describe("the current-workspace tie-break (LEDGE_WORKSPACE)", () => {
  const HAD = Object.hasOwn(process.env, "LEDGE_WORKSPACE");
  const OLD = process.env["LEDGE_WORKSPACE"];
  afterEach(() => {
    if (HAD) process.env["LEDGE_WORKSPACE"] = OLD;
    else delete process.env["LEDGE_WORKSPACE"];
  });

  test("an ambiguous title prefers the current workspace over a fresher note elsewhere", async () => {
    const here = await createNote(ROOT, "# Plan\nhere");
    const there = await createNote(OTHER, "# Plan\nthere");
    await ageTo(here.path, 1_000_000);
    await ageTo(there.path, 2_000_000);
    process.env["LEDGE_WORKSPACE"] = ROOT;
    expect((await call("read_note", { title: "Plan" })).text).toBe("# Plan\nhere");
    // An explicit workspace argument is a narrower ask and beats the env.
    expect((await call("read_note", { title: "Plan", workspace: OTHER })).text).toBe("# Plan\nthere");
  });

  test("a title the current workspace lacks still resolves globally", async () => {
    await createNote(OTHER, "# Elsewhere Only\nfound");
    process.env["LEDGE_WORKSPACE"] = ROOT;
    expect((await call("read_note", { title: "Elsewhere Only" })).text).toContain("found");
  });

  test("a stale LEDGE_WORKSPACE costs nothing — global newest-first decides", async () => {
    const a = await createNote(ROOT, "# Plan\nold");
    const b = await createNote(OTHER, "# Plan\nnew");
    await ageTo(a.path, 1_000_000);
    await ageTo(b.path, 2_000_000);
    process.env["LEDGE_WORKSPACE"] = join(tmpdir(), "ledge-detached-nowhere");
    expect((await call("read_note", { title: "Plan" })).text).toBe("# Plan\nnew");
  });

  test("backlinks resolves its target under the same preference", async () => {
    const here = await createNote(ROOT, "# Target\nhere");
    const there = await createNote(OTHER, "# Target\nthere");
    await ageTo(here.path, 1_000_000);
    await ageTo(there.path, 2_000_000);
    await createNote(ROOT, "# Pointer\n[[Target]]");
    process.env["LEDGE_WORKSPACE"] = ROOT;
    const out = await call("backlinks", { title: "Target" });
    expect(out.target.path).toBe(here.path);
    expect(out.backlinks.map((b: { title: string }) => b.title)).toEqual(["Pointer"]);
  });
});

// The write tier. Both tools route through the store, so what these really
// pin down is that an agent's write inherits the app's rules — H1-slug
// naming, uniqueName dedup, block-append semantics — rather than getting a
// laxer parallel path.
describe("create_note", () => {
  const HAD = Object.hasOwn(process.env, "LEDGE_WORKSPACE");
  const OLD = process.env["LEDGE_WORKSPACE"];
  afterEach(() => {
    if (HAD) process.env["LEDGE_WORKSPACE"] = OLD;
    else delete process.env["LEDGE_WORKSPACE"];
  });

  test("names the file from the H1 and writes the text", async () => {
    delete process.env["LEDGE_WORKSPACE"];
    const out = await call("create_note", { workspace: ROOT, text: "# Fresh Idea\n\nbody" });
    expect(out.path).toBe(join(ROOT, "fresh-idea.md"));
    expect(out.title).toBe("Fresh Idea");
    expect(out.workspace).toBe(ROOT);
    expect((await readNote(out.path))?.text).toBe("# Fresh Idea\n\nbody");
  });

  test("a duplicate title gets a numbered file; the first note is untouched", async () => {
    const first = await call("create_note", { workspace: ROOT, text: "# Plan\nold" });
    const second = await call("create_note", { workspace: ROOT, text: "# Plan\nnew" });
    expect(second.path).toBe(join(ROOT, "plan-2.md"));
    expect((await readNote(first.path))?.text).toBe("# Plan\nold");
  });

  test("headingless text is created as untitled, not refused", async () => {
    const out = await call("create_note", { workspace: ROOT, text: "just a thought" });
    expect(out.path).toBe(join(ROOT, "untitled.md"));
  });

  test("with no workspace argument, $LEDGE_WORKSPACE says where 'here' is", async () => {
    process.env["LEDGE_WORKSPACE"] = OTHER;
    const out = await call("create_note", { text: "# From The Terminal\n" });
    expect(out.workspace).toBe(OTHER);
    expect(out.path).toBe(join(OTHER, "from-the-terminal.md"));
  });

  test("a stale $LEDGE_WORKSPACE explains itself instead of leaking the guard", async () => {
    process.env["LEDGE_WORKSPACE"] = join(tmpdir(), "ledge-detached-nowhere");
    expect(call("create_note", { text: "# Lost\n" })).rejects.toThrow("LEDGE_WORKSPACE");
  });

  test("no argument, no env: a sole workspace is the default, several must be named", async () => {
    delete process.env["LEDGE_WORKSPACE"];
    expect(call("create_note", { text: "# Homeless\n" })).rejects.toThrow("several workspaces");
    await writeFile(WORKSPACES_PATH, JSON.stringify({ version: 1, roots: [ROOT] }));
    const out = await call("create_note", { text: "# Homed\n" });
    expect(out.workspace).toBe(ROOT);
  });

  test("an unregistered workspace argument is refused; empty text is too", async () => {
    expect(call("create_note", { workspace: "/etc", text: "# Nope\n" })).rejects.toThrow(
      "not a registered workspace root",
    );
    expect(call("create_note", { workspace: ROOT, text: "  \n" })).rejects.toThrow("give the note's text");
  });
});

describe("append_note", () => {
  const HAD = Object.hasOwn(process.env, "LEDGE_NOTE");
  const OLD = process.env["LEDGE_NOTE"];
  afterEach(() => {
    if (HAD) process.env["LEDGE_NOTE"] = OLD;
    else delete process.env["LEDGE_NOTE"];
  });

  test("appends as a new block: one blank line between, one trailing newline", async () => {
    const n = await createNote(ROOT, "# Log\n\nfirst entry\n\n\n");
    const out = await call("append_note", { title: "Log", text: "\n\nsecond entry\n\n" });
    expect(out.path).toBe(n.path);
    expect(out.divergedTo).toBeUndefined();
    expect((await readNote(n.path))?.text).toBe("# Log\n\nfirst entry\n\nsecond entry\n");
  });

  test("no title or path appends to the current note ($LEDGE_NOTE)", async () => {
    const n = await createNote(ROOT, "# Current\n");
    process.env["LEDGE_NOTE"] = n.path;
    await call("append_note", { text: "from the agent" });
    expect((await readNote(n.path))?.text).toBe("# Current\n\nfrom the agent\n");
  });

  test("the title and filename survive an append untouched", async () => {
    const n = await createNote(ROOT, "# Sturdy\nbody");
    const out = await call("append_note", { path: n.path, text: "# Not A New Title\nmore" });
    expect(out.path).toBe(n.path);
    expect(out.title).toBe("Sturdy");
    expect((await readNote(n.path))?.text).toContain("# Not A New Title");
  });

  test("empty additions and unknown targets are refused", async () => {
    expect(call("append_note", { title: "Anything", text: "  \n " })).rejects.toThrow("give the text to append");
    expect(call("append_note", { title: "No Such Note", text: "hi" })).rejects.toThrow('no note titled');
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
