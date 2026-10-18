import { describe, expect, test } from "bun:test";
import {
  blockLabel,
  confirmQuestion,
  driverScript,
  formatBlockList,
  hostRefusal,
  sudoRefusal,
  planRun,
  runOutcome,
  type RunnableBlock,
  type RunPlan,
} from "./runBlocks";
import { DEFAULT_SETTINGS } from "../shared/settings";
import type { RunnerSpec } from "./runner";

const LANGS = DEFAULT_SETTINGS.blocks.runnable;

const NOTE = [
  "# Deploy",
  "",
  "```sh name=build",
  "make build",
  "```",
  "",
  "```yaml",
  "key: value",
  "```",
  "",
  "## Migrate",
  "",
  '```sh name=migrate confirm="Touch the production database?"',
  "./migrate.sh",
  "```",
  "",
  "```sh norun name=install",
  "sudo apt-get install x",
  "```",
  "",
  "## Rollback",
  "",
  "```python",
  "print('back')",
  "```",
  "",
].join("\n");

const plan = (text: string, req: Partial<{ heading: string; block: string; all: boolean }> = {}): RunPlan =>
  planRun(text, { heading: req.heading ?? null, block: req.block ?? null, all: req.all ?? false }, LANGS);

const indexes = (p: RunPlan): number[] => (p.kind === "error" ? [] : p.blocks.map((b) => b.index));
const message = (p: RunPlan): string => (p.kind === "error" ? p.message : "");

describe("planRun: what a command line names", () => {
  test("no block, section or --all lists the runnable blocks, numbered among themselves", () => {
    const p = plan(NOTE);
    expect(p.kind).toBe("list");
    if (p.kind !== "list") return;
    expect(p.blocks.map((b) => [b.index, b.line, b.lang, b.name, b.section])).toEqual([
      [1, 3, "sh", "build", "Deploy"],
      [2, 13, "sh", "migrate", "Migrate"],
      [3, 23, "python", null, "Rollback"],
    ]);
  });

  test("--all runs every runnable block in order", () => {
    const p = plan(NOTE, { all: true });
    expect(p.kind).toBe("run");
    expect(indexes(p)).toEqual([1, 2, 3]);
  });

  test("-b takes a number from the list or a name, case-insensitively", () => {
    expect(indexes(plan(NOTE, { block: "3" }))).toEqual([3]);
    expect(indexes(plan(NOTE, { block: "Migrate" }))).toEqual([2]);
  });

  test("Title#Heading runs that section's blocks, subsections included", () => {
    expect(indexes(plan(NOTE, { heading: "migrate" }))).toEqual([2]);
    expect(indexes(plan(NOTE, { heading: "Deploy" }))).toEqual([1, 2, 3]);
  });

  test("a confirm marker and the note-wide confirm: reach the plan", () => {
    const p = plan(NOTE, { all: true });
    if (p.kind !== "run") throw new Error("expected a run");
    expect(p.blocks.map((b) => b.confirm)).toEqual([null, { message: "Touch the production database?" }, null]);
    const wide = plan("---\nconfirm: true\n---\n# T\n\n```sh\nls\n```\n", { all: true });
    if (wide.kind !== "run") throw new Error("expected a run");
    expect(wide.blocks[0]!.confirm).toEqual({ message: null });
  });
});

describe("planRun: refusals", () => {
  test("-b with a section, or with --all, is a usage error", () => {
    const p = plan(NOTE, { block: "1", heading: "Migrate" });
    expect(p).toMatchObject({ kind: "error", exit: 2 });
    expect(plan(NOTE, { block: "1", all: true })).toMatchObject({ kind: "error", exit: 2 });
  });

  test("a number past the end says how many there are", () => {
    expect(message(plan(NOTE, { block: "4" }))).toBe("there is no block 4: this note has 3 runnable blocks");
  });

  test("a name that matches nothing, or more than one block, is refused", () => {
    expect(message(plan(NOTE, { block: "deploy" }))).toBe('no block is named "deploy" in this note');
    const twice = "```sh name=x\na\n```\n\n```sh name=X\nb\n```\n";
    expect(message(plan(twice, { block: "x" }))).toBe('more than one block is named "x" (lines 1, 5)');
  });

  test("a named block that cannot run says why, in the app's words", () => {
    expect(message(plan(NOTE, { block: "install" }))).toBe(
      'block "install" is marked norun: it is here to read or copy, not to run from this note',
    );
    expect(message(plan("```sh name=open\nls\n", { block: "open" }))).toBe(
      'block "open" has no closing fence, so there is nothing to run yet',
    );
    expect(message(plan("```yaml name=cfg\na: 1\n```\n", { block: "cfg" }))).toBe(
      'block "cfg" is a yaml block, which is not in blocks.runnable in settings.jsonc',
    );
  });

  test("an unknown heading, or a section with nothing to run", () => {
    expect(message(plan(NOTE, { heading: "Nope" }))).toBe('no heading "Nope" in this note');
    expect(message(plan("# A\n\n## Empty\n\ntext\n", { heading: "Empty" }))).toBe('no runnable blocks under "Empty"');
    expect(message(plan("# A\n\ntext\n", { all: true }))).toBe("this note has no runnable blocks");
  });
});

describe("hostRefusal", () => {
  const params = (hosts: string[]) => {
    const p = plan(`---\nhost: ${hosts.join(" ")}\n---\n`);
    if (p.kind === "error") throw new Error(p.message);
    return p.params;
  };

  test("no host:, or only local, runs here", () => {
    const p = plan("# T\n");
    if (p.kind === "error") throw new Error(p.message);
    expect(hostRefusal(p.params)).toBeNull();
    expect(hostRefusal(params(["local"]))).toBeNull();
  });

  test("any other machine is refused, one host or several", () => {
    expect(hostRefusal(params(["deploy@prod"]))).toContain("on deploy@prod (its host: line)");
    expect(hostRefusal(params(["staging", "prod"]))).toContain("on staging, prod (its host: line)");
  });
});

const block = (over: Partial<RunnableBlock>): RunnableBlock => ({
  index: 1,
  line: 3,
  lang: "sh",
  name: null,
  section: null,
  code: "ls",
  confirm: null,
  ...over,
});

describe("formatBlockList", () => {
  test("pads the columns, drops empty ones, and marks confirm", () => {
    expect(
      formatBlockList([
        block({ index: 1, code: "\nmake build", section: "Deploy" }),
        block({ index: 12, lang: "python", name: "migrate", section: "Migrate", confirm: { message: null } }),
      ]),
    ).toEqual([" 1  sh               Deploy   make build", "12  python  migrate  Migrate  ls  (confirm)"]);
  });

  test("a long first line is cut", () => {
    const [row] = formatBlockList([block({ code: "x".repeat(80) })]);
    expect(row).toBe(`1  sh  ${"x".repeat(57)}...`);
  });
});

describe("labels and questions", () => {
  test("blockLabel names the number, the name when there is one, the language and line", () => {
    expect(blockLabel(block({ index: 2, name: "migrate", line: 15 }))).toBe('block 2 "migrate" (sh, line 15)');
    expect(blockLabel(block({}))).toBe("block 1 (sh, line 3)");
  });

  test("confirmQuestion uses the fence's question when it has one", () => {
    expect(confirmQuestion(block({ confirm: { message: "Wipe it?" } }))).toBe("Block 1 (sh, line 3) asks first: Wipe it?");
    expect(confirmQuestion(block({ confirm: { message: null } }))).toBe("Block 1 (sh, line 3) asks before it runs:");
  });
});

describe("driverScript and runOutcome", () => {
  const spec = (command: string): RunnerSpec => ({ kind: "shell", path: "", contents: "", command, remote: false });

  test("one block: no banner, its status ends the script", () => {
    expect(driverScript([block({ index: 2 })], [spec("source /tmp/a.sh")], "/tmp/d")).toBe(
      [
        "printf '%s' 2 > '/tmp/d/current'",
        "source /tmp/a.sh",
        "__ledge_status=$?",
        '[ "$__ledge_status" -eq 0 ] || exit "$__ledge_status"',
        ": > '/tmp/d/done'",
        "",
      ].join("\n"),
    );
  });

  test("several blocks: a banner on stderr before each", () => {
    const script = driverScript([block({ index: 1 }), block({ index: 2, line: 9 })], [spec("a"), spec("b")], "/tmp/d");
    expect(script).toContain("printf '%s\\n' 'ledge: running block 1 (sh, line 3)' >&2\n");
    expect(script).toContain("printf '%s\\n' 'ledge: running block 2 (sh, line 9)' >&2\n");
  });

  test("runOutcome names the block that stopped a run of several", () => {
    const two = [block({ index: 1 }), block({ index: 3, line: 9 })];
    expect(runOutcome(two, 0, 3, true)).toBeNull();
    expect(runOutcome(two, 4, 1, false)).toBe("block 1 (sh, line 3) exited 4; the blocks after it did not run");
    expect(runOutcome(two, 4, 3, false)).toBe("block 3 (sh, line 9) exited 4");
    expect(runOutcome(two, 0, 1, false)).toBe("block 1 (sh, line 3) exited the shell; the blocks after it did not run");
    expect(runOutcome([block({})], 1, 1, false)).toBeNull();
  });
});

describe("sudoRefusal", () => {
  test("a note with no sudo: line runs here", () => {
    const p = plan("# T\n");
    if (p.kind === "error") throw new Error(p.message);
    expect(sudoRefusal(p.params)).toBeNull();
  });

  test("a note that runs as another user is refused", () => {
    const p = plan("---\nsudo: root\n---\n");
    if (p.kind === "error") throw new Error(p.message);
    expect(sudoRefusal(p.params)).toContain("as root (its sudo: line)");
  });
});
