// The CLI verbs against a real filesystem: what `ledge` actually prints and
// exits with, driven through runCli with the process seams stubbed. The
// interesting decisions are the shell-shaped ones — cwd scoping ls and
// anchoring new, the grep exit contract, path-vs-title targeting — plus one
// spawned-process pass proving the import.meta.main assembly.
//
// Same scratch-home discipline as notes.fs.test.ts: the preload pointed
// APP_HOME at a temp dir before anything imported, and the guard re-checks.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readNote } from "./notes";
import { takeOpenRequest } from "./openRequest";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import { runCli, type CliIo } from "./cli";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

// The deixis env is the CLI's input surface, so tests own it completely:
// cleared before each test, restored for whoever runs after this file.
const SAVED_WS = process.env["LEDGE_WORKSPACE"];
const SAVED_NOTE = process.env["LEDGE_NOTE"];
afterAll(() => {
  if (SAVED_WS === undefined) delete process.env["LEDGE_WORKSPACE"];
  else process.env["LEDGE_WORKSPACE"] = SAVED_WS;
  if (SAVED_NOTE === undefined) delete process.env["LEDGE_NOTE"];
  else process.env["LEDGE_NOTE"] = SAVED_NOTE;
});

let ROOT = "";
let OTHER = "";

beforeEach(async () => {
  delete process.env["LEDGE_WORKSPACE"];
  delete process.env["LEDGE_NOTE"];
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  ROOT = await createManaged("Notes");
  OTHER = await createManaged("Other");
});

interface Run {
  code: number;
  out: string[];
  err: string[];
  /** How many times the verb tried to launch/activate the app. */
  opens: number;
}

// Run a verb in-process: stdout/stderr captured per line, cwd and piped
// stdin injected, the app launch recorded instead of performed. tmpdir() is
// the standing "outside every workspace" cwd — it CONTAINS the scratch
// APP_HOME, and rootContaining only looks downward.
async function run(argv: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  let opens = 0;
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdin: async () => opts.stdin ?? null,
    cwd: () => opts.cwd ?? tmpdir(),
    openApp: async () => {
      opens += 1;
      return true;
    },
  };
  return { code: await runCli(argv, io), out, err, opens };
}

describe("ls", () => {
  test("a cwd inside a workspace scopes the list; --all and an outside cwd go wide", async () => {
    await run(["new", "Alpha"], { cwd: ROOT });
    await run(["new", "Beta"], { cwd: OTHER });
    const scoped = await run(["ls"], { cwd: ROOT });
    expect(scoped.code).toBe(0);
    expect(scoped.out.join("\n")).toContain("Alpha");
    expect(scoped.out.join("\n")).not.toContain("Beta");
    const wide = await run(["ls", "--all"], { cwd: ROOT });
    expect(wide.out.join("\n")).toContain("Beta");
    const outside = await run(["ls"]);
    expect(outside.out.join("\n")).toContain("Beta");
  });

  test("--json prints the handler's shape, not rows", async () => {
    await run(["new", "Alpha"], { cwd: ROOT });
    const r = await run(["ls", "--json"], { cwd: ROOT });
    const parsed = JSON.parse(r.out.join("\n"));
    expect(parsed[0]).toMatchObject({ title: "Alpha", workspace: ROOT });
  });
});

describe("new", () => {
  test("creates in the cwd's workspace, prints only the path, and never clobbers", async () => {
    const first = await run(["new", "Standup", "Notes"], { cwd: ROOT });
    expect(first.code).toBe(0);
    expect(first.out).toEqual([join(ROOT, "standup-notes.md")]);
    expect((await readNote(first.out[0]!))?.text).toBe("# Standup Notes\n");
    const second = await run(["new", "Standup", "Notes"], { cwd: ROOT });
    expect(second.out).toEqual([join(ROOT, "standup-notes-2.md")]);
  });

  test("piped stdin becomes the body under the titled H1", async () => {
    const r = await run(["new", "Inbox"], { cwd: ROOT, stdin: "first capture\n" });
    expect((await readNote(r.out[0]!))?.text).toBe("# Inbox\n\nfirst capture\n");
  });

  test("stdin without a title is the whole note, H1 and all", async () => {
    const r = await run(["new"], { cwd: ROOT, stdin: "# Piped Title\n\nbody\n" });
    expect(r.out).toEqual([join(ROOT, "piped-title.md")]);
  });

  test("a workspace folder name scopes creation from anywhere", async () => {
    const r = await run(["new", "Elsewhere", "-w", "other"]);
    expect(r.out).toEqual([join(OTHER, "elsewhere.md")]);
  });

  test("outside every workspace with several registered, the error says to name one", async () => {
    const r = await run(["new", "Lost"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("several workspaces");
  });

  test("no title and no stdin is a usage error", async () => {
    const r = await run(["new"], { cwd: ROOT });
    expect(r.code).toBe(2);
  });

  test("--template instantiates a note by title, substituted and retitled", async () => {
    await run(["new", "Meeting"], { cwd: ROOT, stdin: "Agenda for {{title}}.\n" });
    const r = await run(["new", "Sprint", "Review", "--template", "Meeting"], { cwd: ROOT });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([join(ROOT, "sprint-review.md")]);
    expect((await readNote(r.out[0]!))?.text).toBe("# Sprint Review\n\nAgenda for Sprint Review.\n");
  });

  test("--template refuses a piped second body, and needs a title", async () => {
    await run(["new", "Meeting"], { cwd: ROOT });
    const piped = await run(["new", "T", "--template", "Meeting"], { cwd: ROOT, stdin: "body\n" });
    expect(piped.code).toBe(2);
    const untitled = await run(["new", "--template", "Meeting"], { cwd: ROOT });
    expect(untitled.code).toBe(2);
  });

  test("--template naming no note fails with the humanized error", async () => {
    const r = await run(["new", "T", "--template", "Ghost"], { cwd: ROOT });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain('no note titled "Ghost"');
  });
});

describe("today", () => {
  test("creates today's note, prints its path, and opens the app on it", async () => {
    const r = await run(["today"], { cwd: ROOT });
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.opens).toBe(1);
    const req = await takeOpenRequest();
    expect(req?.path).toBe(r.out[0]!);
    const text = (await readNote(r.out[0]!))?.text ?? "";
    expect(text).toMatch(/^# \d{4}-\d{2}-\d{2}\n$/);
  });

  test("a second run the same day resolves the same note", async () => {
    const first = await run(["today"], { cwd: ROOT });
    const second = await run(["today"], { cwd: ROOT });
    expect(second.out).toEqual(first.out);
  });

  test("cwd deixis picks the workspace; -w overrides it", async () => {
    const here = await run(["today"], { cwd: OTHER });
    expect(here.out[0]!.startsWith(OTHER)).toBe(true);
    const scoped = await run(["today", "-w", "notes"], { cwd: OTHER });
    expect(scoped.out[0]!.startsWith(ROOT)).toBe(true);
  });

  test("outside every workspace with several registered, the error teaches the knob", async () => {
    const r = await run(["today"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("daily.workspace");
  });
});

describe("cat", () => {
  test("by title from anywhere, raw markdown on stdout", async () => {
    await run(["new", "Recipe"], { cwd: ROOT, stdin: "steps here\n" });
    const r = await run(["cat", "Recipe"]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toBe("# Recipe\n\nsteps here");
  });

  test("a .md argument is a path, resolved against the cwd", async () => {
    await run(["new", "Recipe"], { cwd: ROOT });
    const r = await run(["cat", "recipe.md"], { cwd: ROOT });
    expect(r.out.join("\n")).toBe("# Recipe");
  });

  test("an unknown title fails with the handler's guidance, exit 1", async () => {
    const r = await run(["cat", "No Such Note"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("no note titled");
  });

  test("no argument outside a note terminal is a usage error", async () => {
    const r = await run(["cat"]);
    expect(r.code).toBe(2);
  });
});

describe("append", () => {
  test("-m appends to the titled note and says which note it picked", async () => {
    await run(["new", "Inbox"], { cwd: ROOT });
    const r = await run(["append", "Inbox", "-m", "buy milk"]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain('appended to "Inbox"');
    expect((await readNote(join(ROOT, "inbox.md")))?.text).toBe("# Inbox\n\nbuy milk\n");
  });

  test("--heading lands the text inside that section, not at the end", async () => {
    await run(["new"], { cwd: ROOT, stdin: "# Log\n\n## Monday\n\nrain\n\n## Tuesday\n\nsun\n" });
    await run(["append", "Log", "-m", "wind", "--heading", "Monday"]);
    expect((await readNote(join(ROOT, "log.md")))?.text).toBe("# Log\n\n## Monday\n\nrain\n\nwind\n\n## Tuesday\n\nsun\n");
  });

  test("no title in a note's terminal appends to the current note via LEDGE_NOTE", async () => {
    await run(["new", "Current"], { cwd: ROOT });
    process.env["LEDGE_NOTE"] = join(ROOT, "current.md");
    const r = await run(["append", "-m", "from the drawer"]);
    expect(r.code).toBe(0);
    expect((await readNote(join(ROOT, "current.md")))?.text).toBe("# Current\n\nfrom the drawer\n");
  });

  test("no text at all is a usage error, before any note is touched", async () => {
    await run(["new", "Inbox"], { cwd: ROOT });
    const r = await run(["append", "Inbox"]);
    expect(r.code).toBe(2);
    expect((await readNote(join(ROOT, "inbox.md")))?.text).toBe("# Inbox\n");
  });
});

describe("search", () => {
  test("prints cwd-relative path:line: match rows inside a workspace", async () => {
    await run(["new", "Recipe"], { cwd: ROOT, stdin: "add saffron last\n" });
    const r = await run(["search", "saffron"], { cwd: ROOT });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["recipe.md:3: add saffron last"]);
  });

  test("cwd scoping hides other workspaces; --all finds them; no match exits 1", async () => {
    await run(["new", "Far"], { cwd: OTHER, stdin: "needle\n" });
    const scoped = await run(["search", "needle"], { cwd: ROOT });
    expect(scoped.code).toBe(1);
    expect(scoped.out).toEqual([]);
    const wide = await run(["search", "needle", "--all"], { cwd: ROOT });
    expect(wide.code).toBe(0);
    expect(wide.out.length).toBe(1);
  });
});

describe("tags", () => {
  test("bare: #tag rows with note counts, scoped to the cwd workspace; --all goes wide", async () => {
    await run(["new", "Tagged"], { cwd: ROOT, stdin: "about #work and #home\n" });
    await run(["new", "Far"], { cwd: OTHER, stdin: "#elsewhere\n" });
    const r = await run(["tags"], { cwd: ROOT });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["#home  1", "#work  1"]);
    const wide = await run(["tags", "--all"], { cwd: ROOT });
    expect(wide.out.length).toBe(3);
  });

  test("with a tag: grep-shaped occurrence rows; no match exits 1", async () => {
    await run(["new", "Tagged"], { cwd: ROOT, stdin: "about #work today\n" });
    const r = await run(["tags", "work"], { cwd: ROOT });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["tagged.md:3: about #work today"]);
    const miss = await run(["tags", "nope"], { cwd: ROOT });
    expect(miss.code).toBe(1);
    expect(miss.out).toEqual([]);
  });

  test("--json prints the handler's shape, not rows", async () => {
    await run(["new", "Tagged"], { cwd: ROOT, stdin: "#work\n" });
    const r = await run(["tags", "--json"], { cwd: ROOT });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.join("\n")).tags).toEqual([{ tag: "work", count: 1 }]);
  });
});

describe("workspaces", () => {
  test("one row per root, kind included", async () => {
    const r = await run(["workspaces"]);
    expect(r.code).toBe(0);
    expect(r.out.length).toBe(2);
    expect(r.out[0]).toContain("managed");
  });
});

describe("install", () => {
  test("an explicit dir gets the shim, path on stdout, PATH hint on stderr", async () => {
    const bin = join(APP_HOME, "shim-bin"); // scratch by construction — never a real bin dir
    const r = await run(["install", bin]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([join(bin, "ledge")]);
    expect(r.err.join("\n")).toContain("not on your PATH");
    const text = await Bun.file(join(bin, "ledge")).text();
    expect(text).toContain('"$@"'); // the shim, execing this very entry
    expect(text).toContain("cli.ts");
  });
});

describe("open (the bare-title form)", () => {
  test("a title writes the request file and launches the app", async () => {
    await run(["new", "Meeting", "Notes"], { cwd: ROOT });
    const r = await run(["Meeting", "Notes"]);
    expect(r.code).toBe(0);
    expect(r.opens).toBe(1);
    const open = await takeOpenRequest();
    expect(open?.path).toBe(join(ROOT, "meeting-notes.md"));
    expect(open?.root).toBe(ROOT);
  });

  test("`open` spelled out reaches a note titled like a verb", async () => {
    await run(["new", "ls"], { cwd: ROOT });
    const r = await run(["open", "ls"]);
    expect(r.code).toBe(0);
    expect((await takeOpenRequest())?.path).toBe(join(ROOT, "ls.md"));
  });

  test("bare `ledge` opens the app with no request pending", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.opens).toBe(1);
    expect(await takeOpenRequest()).toBeNull();
  });

  test("a title that names nothing fails in CLI dialect, and no request is left behind", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain('no note titled "frobnicate"');
    expect(r.err.join("\n")).toContain("`ledge ls`"); // humanize(): advice in the shell's own verbs
    expect(r.opens).toBe(0);
    expect(await takeOpenRequest()).toBeNull();
  });
});

// The spawned seam: the actual `bun src/bun/cli.ts` a shim would exec, with
// its own hand-crafted home (a separate process — the preload's APP_HOME
// does not reach it). What only this proves is the assembly: import.meta.main
// fires, the env the shell set is honored, stdout carries the result alone.
describe("spawned process", () => {
  test("cat by title, and mcp answering initialize", async () => {
    const HOME = await mkdtemp(join(tmpdir(), "ledge-cli-proc-"));
    const WS = join(HOME, "ws");
    try {
      await mkdir(WS, { recursive: true });
      await writeFile(join(HOME, ".workspaces.json"), JSON.stringify({ version: 1, roots: [WS] }));
      await writeFile(join(WS, "hello-shell.md"), "# Hello Shell\n\nsecret word: xyzzy\n");

      const cli = join(import.meta.dir, "cli.ts");
      const cat = Bun.spawn({
        cmd: [process.execPath, cli, "cat", "hello shell"],
        env: { ...process.env, LEDGE_NOTES_ROOT: HOME },
        stdout: "pipe",
        stderr: "pipe",
      });
      const catOut = await new Response(cat.stdout).text();
      expect(await cat.exited).toBe(0);
      expect(catOut).toBe("# Hello Shell\n\nsecret word: xyzzy\n");

      const mcp = Bun.spawn({
        cmd: [process.execPath, cli, "mcp"],
        env: { ...process.env, LEDGE_NOTES_ROOT: HOME },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      mcp.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n",
      );
      await mcp.stdin.end();
      const mcpOut = await new Response(mcp.stdout).text();
      expect(await mcp.exited).toBe(0);
      const reply = JSON.parse(mcpOut.trim()) as { result: { serverInfo: { name: string } } };
      expect(reply.result.serverInfo.name).toBe("ledge");
    } finally {
      await rm(HOME, { recursive: true, force: true });
    }
  });
});
