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
import { SETTINGS_PATH } from "./settings";
import { isoDateOf } from "../shared/template";

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

  test("a template: true note is flagged in its row; the rest carry no flag", async () => {
    await createNote(ROOT, "---\ntemplate: true\n---\n# Meeting\n");
    await createNote(ROOT, "# Plain\n");
    const rows = await call("list_notes", { workspace: ROOT });
    const byTitle = new Map(rows.map((n: { title: string }) => [n.title, n]));
    expect((byTitle.get("Meeting") as { template?: boolean }).template).toBe(true);
    expect("template" in (byTitle.get("Plain") as object)).toBe(false);
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

describe("create_note from a template", () => {
  test("instantiates the named note: tokens substituted, H1 forced, frontmatter carried", async () => {
    await createNote(ROOT, "---\ntags: meeting\n---\n\n# Meeting\n\nOn {{date}}.\n");
    const out = await call("create_note", { workspace: ROOT, template: "Meeting", title: "Standup" });
    expect(out.path).toBe(join(ROOT, "standup.md"));
    expect(out.title).toBe("Standup");
    expect((await readNote(out.path))?.text).toBe(
      `---\ntags: meeting\n---\n\n# Standup\n\nOn ${isoDateOf(new Date())}.\n`,
    );
  });

  test("a template needs a title, and refuses a second body via text", async () => {
    await createNote(ROOT, "# Meeting\n");
    expect(call("create_note", { workspace: ROOT, template: "Meeting" })).rejects.toThrow(
      "needs a `title`",
    );
    expect(
      call("create_note", { workspace: ROOT, template: "Meeting", title: "T", text: "# T\n" }),
    ).rejects.toThrow("not both");
  });

  test("a template that names no note throws rather than creating bare", async () => {
    expect(call("create_note", { workspace: ROOT, template: "Ghost", title: "T" })).rejects.toThrow(
      'no note titled "Ghost"',
    );
  });
});

describe("daily_note", () => {
  const HAD = Object.hasOwn(process.env, "LEDGE_WORKSPACE");
  const OLD = process.env["LEDGE_WORKSPACE"];
  afterEach(() => {
    if (HAD) process.env["LEDGE_WORKSPACE"] = OLD;
    else delete process.env["LEDGE_WORKSPACE"];
  });

  test("creates today's note once, then returns it (the created flag says which)", async () => {
    const title = isoDateOf(new Date());
    const first = await call("daily_note", { workspace: ROOT });
    expect(first.created).toBe(true);
    expect(first.title).toBe(title);
    expect(first.path).toBe(join(ROOT, `${title}.md`));
    const second = await call("daily_note", { workspace: ROOT });
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(await readNote(join(ROOT, `${title}-2.md`))).toBeNull();
  });

  test("the daily.workspace setting outranks the env; an explicit argument outranks both", async () => {
    await writeFile(SETTINGS_PATH, JSON.stringify({ daily: { workspace: OTHER } }));
    process.env["LEDGE_WORKSPACE"] = ROOT;
    expect((await call("daily_note")).workspace).toBe(OTHER);
    expect((await call("daily_note", { workspace: ROOT })).workspace).toBe(ROOT);
  });

  test("the note marked template: daily shapes the created note — no settings involved", async () => {
    await createNote(ROOT, "---\ntemplate: daily\n---\n# Daily Template\n\nCarry over [[{{yesterday}}]].\n");
    const out = await call("daily_note", { workspace: ROOT });
    expect((await readNote(out.path))?.text).toContain("Carry over [[");
    expect((await readNote(out.path))?.text).toContain(`# ${isoDateOf(new Date())}`);
    // The role marker stayed with the template, not the day's note.
    expect((await readNote(out.path))?.text).not.toContain("template:");
  });

  test("with several workspaces and no pin, the error teaches the knob", async () => {
    delete process.env["LEDGE_WORKSPACE"];
    expect(call("daily_note")).rejects.toThrow("daily.workspace");
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

  test("a heading argument appends inside that section, not at the end", async () => {
    // The splice itself is shared/wikilinks.test.ts's subject; what this pins
    // is the tool wiring — heading + the env-default note compose, and the
    // result still reports the note's identity.
    const n = await createNote(ROOT, "# Jokes\n\n## Puns\n\nfirst\n\n## Long Ones\n\nsaga\n");
    process.env["LEDGE_NOTE"] = n.path;
    const out = await call("append_note", { heading: "puns", text: "second" });
    expect(out.path).toBe(n.path);
    expect((await readNote(n.path))?.text).toBe("# Jokes\n\n## Puns\n\nfirst\n\nsecond\n\n## Long Ones\n\nsaga\n");
  });

  test("a note ending with its own prompt block keeps the block last — the append lands above it", async () => {
    // The "add another joke to this note" note: content, then the runnable
    // ```prompt fence that produced this very call. Below the block would
    // interleave results with the button (and each rerun would bury it).
    const n = await createNote(ROOT, "# Jokes\n\n> joke one\n\n```prompt\nadd another joke\n```\n");
    process.env["LEDGE_NOTE"] = n.path;
    await call("append_note", { text: "> joke two" });
    expect((await readNote(n.path))?.text).toBe(
      "# Jokes\n\n> joke one\n\n> joke two\n\n```prompt\nadd another joke\n```\n",
    );
  });

  test("a heading the note lacks is an error that lists what it has", async () => {
    await createNote(ROOT, "# Recipes\n\n## Soups\n\n## Breads\n");
    expect(call("append_note", { title: "Recipes", heading: "Desserts", text: "x" })).rejects.toThrow(
      "its headings are: Recipes, Soups, Breads",
    );
  });

  test("empty additions and unknown targets are refused", async () => {
    expect(call("append_note", { title: "Anything", text: "  \n " })).rejects.toThrow("give the text to append");
    expect(call("append_note", { title: "No Such Note", text: "hi" })).rejects.toThrow('no note titled');
  });
});

// The revision tool: exact-match replacement, no fuzz. The decisions worth
// pinning are the refusals (they teach the agent to self-correct: exactness,
// ambiguity counts, replace_all as the escape), the literal-replacement
// hazard ($-patterns), and that an edit reaching the H1 retitles the result.
describe("edit_note", () => {
  const HAD = Object.hasOwn(process.env, "LEDGE_NOTE");
  const OLD = process.env["LEDGE_NOTE"];
  afterEach(() => {
    if (HAD) process.env["LEDGE_NOTE"] = OLD;
    else delete process.env["LEDGE_NOTE"];
  });

  test("replaces one exact match, whitespace included", async () => {
    const n = await createNote(ROOT, "# Plan\n\n- [ ] ship it\n\ndone soon\n");
    const out = await call("edit_note", { title: "Plan", old_text: "- [ ] ship it", new_text: "- [x] ship it" });
    expect(out.path).toBe(n.path);
    expect(out.title).toBe("Plan");
    expect(out.replacements).toBeUndefined();
    expect(out.divergedTo).toBeUndefined();
    expect((await readNote(n.path))?.text).toBe("# Plan\n\n- [x] ship it\n\ndone soon\n");
  });

  test("no title or path edits the current note ($LEDGE_NOTE)", async () => {
    const n = await createNote(ROOT, "# Current\n\nteh typo\n");
    process.env["LEDGE_NOTE"] = n.path;
    await call("edit_note", { old_text: "teh", new_text: "the" });
    expect((await readNote(n.path))?.text).toBe("# Current\n\nthe typo\n");
  });

  test("a non-match is an error that says matching is exact", async () => {
    await createNote(ROOT, "# Plan\n\nreal text\n");
    expect(call("edit_note", { title: "Plan", old_text: "Real Text", new_text: "x" })).rejects.toThrow(
      "the match is exact",
    );
  });

  test("an ambiguous match is an error that counts the occurrences", async () => {
    await createNote(ROOT, "# Plan\n\nfoo\nfoo\nfoo\n");
    expect(call("edit_note", { title: "Plan", old_text: "foo", new_text: "bar" })).rejects.toThrow(
      'appears 3 times in "Plan"',
    );
  });

  test("replace_all changes every occurrence and reports the count", async () => {
    const n = await createNote(ROOT, "# Plan\n\nfoo and foo, then foo\n");
    const out = await call("edit_note", { title: "Plan", old_text: "foo", new_text: "bar", replace_all: true });
    expect(out.replacements).toBe(3);
    expect((await readNote(n.path))?.text).toBe("# Plan\n\nbar and bar, then bar\n");
  });

  test("an empty new_text deletes the match", async () => {
    const n = await createNote(ROOT, "# Plan\n\nkeep DELETEME this\n");
    await call("edit_note", { title: "Plan", old_text: "DELETEME ", new_text: "" });
    expect((await readNote(n.path))?.text).toBe("# Plan\n\nkeep this\n");
  });

  test("the replacement is literal — $-patterns do not expand", async () => {
    // String.replaceAll would turn $& into the match; split/join must not.
    const n = await createNote(ROOT, "# Costs\n\nprice: cheap\n");
    await call("edit_note", { title: "Costs", old_text: "cheap", new_text: "$& or $100" });
    expect((await readNote(n.path))?.text).toBe("# Costs\n\nprice: $& or $100\n");
  });

  test("editing the H1 retitles the note in the result; the file stays put", async () => {
    const n = await createNote(ROOT, "# Draft\n\nbody\n");
    const out = await call("edit_note", { title: "Draft", old_text: "# Draft", new_text: "# Final" });
    expect(out.path).toBe(n.path);
    expect(out.title).toBe("Final");
    expect((await call("read_note", { title: "Final" })).path).toBe(n.path);
  });

  test("an edit that eats the trailing newline gets it restored", async () => {
    const n = await createNote(ROOT, "# Log\n\nlast line\n");
    await call("edit_note", { title: "Log", old_text: "last line\n", new_text: "new last" });
    expect((await readNote(n.path))?.text).toBe("# Log\n\nnew last\n");
  });

  test("empty old_text, identical texts, and unknown notes are refused", async () => {
    await createNote(ROOT, "# Plan\n\nbody\n");
    expect(call("edit_note", { title: "Plan", old_text: "", new_text: "x" })).rejects.toThrow("give old_text");
    expect(call("edit_note", { title: "Plan", old_text: "body", new_text: "body" })).rejects.toThrow(
      "nothing would change",
    );
    expect(call("edit_note", { title: "No Such Note", old_text: "a", new_text: "b" })).rejects.toThrow(
      "no note titled",
    );
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

describe("tags", () => {
  test("the directory merges frontmatter and inline tags across workspaces, counting notes", async () => {
    await createNote(ROOT, "# One\n\n#work twice #work\n");
    await createNote(ROOT, "---\ntags: work, home\n---\n# Two\n\nbody\n");
    await createNote(OTHER, "# Far\n\n#Work elsewhere\n");
    // Counts are notes bearing the tag (One's two occurrences count once),
    // summed across workspaces; identity folds case, first spelling wins.
    const out = await call("tags");
    expect(out.tags).toEqual([
      { tag: "home", count: 1 },
      { tag: "work", count: 3 },
    ]);
    const scoped = await call("tags", { workspace: OTHER });
    expect(scoped.tags).toEqual([{ tag: "Work", count: 1 }]);
  });

  test("with a tag: occurrences newest note first; the query folds case and sheds its #", async () => {
    const old = await createNote(ROOT, "# Old\n\n#work early\n");
    await ageTo(old.path, 1000);
    await createNote(ROOT, "# New\n\nthen #Work again\n");
    const out = await call("tags", { tag: "#WORK" });
    expect(out.truncated).toBe(false);
    expect(out.hits.map((h: { title: string }) => h.title)).toEqual(["New", "Old"]);
    expect(out.hits[0].line).toBe(3);
    expect(out.hits[0].context).toBe("then #Work again");
    expect(out.hits[0].workspace).toBe(ROOT);
    expect(out.hits[0].modified).toMatch(/^\d{4}-/);
  });

  test("an empty or bare-# tag argument asks for the directory, not an error", async () => {
    await createNote(ROOT, "# T\n\n#solo\n");
    expect((await call("tags", { tag: "" })).tags).toEqual([{ tag: "solo", count: 1 }]);
    expect((await call("tags", { tag: "#" })).tags).toEqual([{ tag: "solo", count: 1 }]);
  });
});
