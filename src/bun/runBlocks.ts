// The pure half of `ledge run` (interactions.md §9): which of a note's blocks
// a command line names, the rows that list them, and the script that runs
// them. cli.ts reads the note, asks the questions and spawns the shell.
//
// Blocks are numbered among the note's runnable blocks only, so a number is
// what the list printed. A runnable block is one the app draws a run pair
// on: a runnable language, a closing fence, and no `norun` (§4c, §4e).
import { codeBlocksOf, type CodeBlock } from "../shared/codeBlocks";
import { blockName, confirmFor, noRun, type ConfirmSpec } from "../shared/fenceInfo";
import { LOCAL_HOST, parseFrontmatter, type NoteParams } from "../shared/frontmatter";
import { headingSection, headingsOf } from "../shared/wikilinks";
import { shellQuote } from "./shellQuote";
import type { RunnerSpec } from "./runner";

/** A block `ledge run` can run, as the list shows it. */
export interface RunnableBlock {
  index: number;
  line: number;
  lang: string;
  name: string | null;
  // The nearest heading above the block, or null above the first heading.
  section: string | null;
  code: string;
  confirm: ConfirmSpec | null;
}

export interface RunRequest {
  // From `Title#Heading`: only that section's blocks.
  heading: string | null;
  // From `-b`: a block number or name.
  block: string | null;
  // From `--all`: every runnable block in the note.
  all: boolean;
}

export type RunPlan =
  | { kind: "list"; params: NoteParams; blocks: RunnableBlock[] }
  | { kind: "run"; params: NoteParams; blocks: RunnableBlock[] }
  | { kind: "error"; message: string; exit: 1 | 2 };

// The sentences the app's chords show for the same two cases
// (editor/blocks.ts BLOCK_UNCLOSED and BLOCK_NORUN).
const UNCLOSED = "has no closing fence, so there is nothing to run yet";
const NORUN = "is marked norun: it is here to read or copy, not to run from this note";

/** What a command line asks to run in `text`, a note's whole Markdown. */
export function planRun(text: string, req: RunRequest, runnableLangs: readonly string[]): RunPlan {
  if (req.block !== null && req.heading !== null) {
    return { kind: "error", message: "name a block with -b or a section with #heading, not both", exit: 2 };
  }
  if (req.block !== null && req.all) {
    return { kind: "error", message: "name a block with -b or run them all with --all, not both", exit: 2 };
  }
  const params = parseFrontmatter(text).params;
  const langs = new Set(runnableLangs.map((l) => l.toLowerCase()));
  const headings = headingsOf(text);
  const all = codeBlocksOf(text);
  const isRunnable = (b: CodeBlock): boolean =>
    b.closed && !noRun(b.attrs) && b.lang !== null && langs.has(b.lang.toLowerCase());

  const runnable: RunnableBlock[] = [];
  for (const b of all) {
    if (!isRunnable(b)) continue;
    const above = headings.filter((h) => h.line < b.line).at(-1);
    runnable.push({
      index: runnable.length + 1,
      line: b.line,
      lang: b.lang!,
      name: blockName(b.attrs),
      section: above?.text ?? null,
      code: b.code,
      confirm: confirmFor(b.attrs, params.confirm),
    });
  }

  if (req.block !== null) {
    const want = req.block.trim();
    if (/^\d+$/.test(want)) {
      const hit = runnable[Number(want) - 1];
      if (!hit) {
        const count = runnable.length === 1 ? "1 runnable block" : `${runnable.length} runnable blocks`;
        return { kind: "error", message: `there is no block ${want}: this note has ${count}`, exit: 1 };
      }
      return { kind: "run", params, blocks: [hit] };
    }
    // Names are looked up across every block, so a named block that cannot
    // run gets the reason rather than "no such block".
    const named = all.filter((b) => blockName(b.attrs)?.toLowerCase() === want.toLowerCase());
    if (named.length === 0) return { kind: "error", message: `no block is named "${want}" in this note`, exit: 1 };
    if (named.length > 1) {
      const lines = named.map((b) => b.line).join(", ");
      return { kind: "error", message: `more than one block is named "${want}" (lines ${lines})`, exit: 1 };
    }
    const b = named[0]!;
    if (!b.closed) return { kind: "error", message: `block "${want}" ${UNCLOSED}`, exit: 1 };
    if (noRun(b.attrs)) return { kind: "error", message: `block "${want}" ${NORUN}`, exit: 1 };
    const hit = runnable.find((r) => r.line === b.line);
    if (!hit) {
      const lang = b.lang ?? "plain";
      return {
        kind: "error",
        message: `block "${want}" is a ${lang} block, which is not in blocks.runnable in settings.jsonc`,
        exit: 1,
      };
    }
    return { kind: "run", params, blocks: [hit] };
  }

  let scope = runnable;
  if (req.heading !== null) {
    const section = headingSection(text, req.heading);
    if (!section) return { kind: "error", message: `no heading "${req.heading}" in this note`, exit: 1 };
    scope = runnable.filter((b) => b.line - 1 > section.start && b.line - 1 < section.end);
    if (scope.length === 0) {
      return { kind: "error", message: `no runnable blocks under "${req.heading}"`, exit: 1 };
    }
  }
  if (req.heading !== null || req.all) {
    if (scope.length === 0) return { kind: "error", message: "this note has no runnable blocks", exit: 1 };
    return { kind: "run", params, blocks: scope };
  }
  return { kind: "list", params, blocks: runnable };
}

/**
 * Why this note's blocks cannot run from the CLI, or null when they can.
 * `ledge run` runs on this machine only, so a note whose `host:` line names
 * any other machine is refused rather than run in the wrong place.
 */
export function hostRefusal(params: NoteParams): string | null {
  if (params.hosts.every((h) => h === LOCAL_HOST)) return null;
  return (
    `this note runs its blocks on ${params.hosts.join(", ")} (its host: line), ` +
    `and ledge run only runs blocks on this machine so far. Run it from the app.`
  );
}

/**
 * Why this note's blocks cannot run from the CLI under its `sudo:` line, or
 * null when it has none. `ledge run` runs blocks as the account that typed it,
 * so a note that names another account is refused rather than run as the
 * wrong one.
 */
export function sudoRefusal(params: NoteParams): string | null {
  if (params.sudo === null) return null;
  return (
    `this note runs its blocks as ${params.sudo} (its sudo: line), ` +
    `and ledge run only runs blocks as you so far. Run it from the app.`
  );
}

/** One label for a block in messages: `block 2 "migrate" (sh, line 15)`. */
export function blockLabel(b: RunnableBlock): string {
  return `block ${b.index}${b.name ? ` "${b.name}"` : ""} (${b.lang}, line ${b.line})`;
}

/** The list's rows: number, language, name, section, then the first code line. */
export function formatBlockList(blocks: readonly RunnableBlock[]): string[] {
  const cols = blocks.map((b) => [
    String(b.index),
    b.lang,
    b.name ?? "",
    b.section ?? "",
    preview(b.code) + (b.confirm ? "  (confirm)" : ""),
  ]);
  const widths = [0, 1, 2, 3].map((i) => cols.reduce((w, c) => Math.max(w, c[i]!.length), 0));
  return cols.map((c) =>
    c
      .map((cell, i) => (i === 0 ? cell.padStart(widths[0]!) : i < 4 ? cell.padEnd(widths[i]!) : cell))
      .filter((cell, i) => i === 4 || widths[i]! > 0)
      .join("  ")
      .trimEnd(),
  );
}

// The block's first non-blank line, cut to fit a terminal row.
function preview(code: string): string {
  const first = code.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return first.length > 60 ? first.slice(0, 57) + "..." : first;
}

/** What the confirm prompt says above the block's code (interactions.md §4b). */
export function confirmQuestion(b: RunnableBlock): string {
  const label = blockLabel(b);
  const capital = label[0]!.toUpperCase() + label.slice(1);
  return b.confirm?.message ? `${capital} asks first: ${b.confirm.message}` : `${capital} asks before it runs:`;
}

/**
 * The script the shell runs: each block in order, stopping at the first that
 * exits non-zero. One shell runs them all, so a `cd` or `export` in one block
 * reaches the next, as it does in the app. Before each block the script writes
 * its index to `<dir>/current`, and after the last it creates `<dir>/done`,
 * so `runOutcome` can say which block stopped the run.
 */
export function driverScript(blocks: readonly RunnableBlock[], specs: readonly RunnerSpec[], dir: string): string {
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (blocks.length > 1) out.push(`printf '%s\\n' ${shellQuote(`ledge: running ${blockLabel(b)}`)} >&2`);
    out.push(`printf '%s' ${b.index} > ${shellQuote(`${dir}/current`)}`);
    out.push(specs[i]!.command);
    out.push(`__ledge_status=$?`);
    out.push(`[ "$__ledge_status" -eq 0 ] || exit "$__ledge_status"`);
  });
  out.push(`: > ${shellQuote(`${dir}/done`)}`);
  return out.join("\n") + "\n";
}

/**
 * What to tell the caller after the script exits, or null for nothing. A
 * single block's failure needs no sentence: its own output and the exit code
 * say it. Across several blocks, the sentence says which one stopped the run.
 * `current` is the index the script last wrote; `done` whether it finished.
 */
export function runOutcome(
  blocks: readonly RunnableBlock[],
  status: number,
  current: number | null,
  done: boolean,
): string | null {
  if (blocks.length < 2 || (status === 0 && done)) return null;
  const pos = blocks.findIndex((b) => b.index === current);
  const b = blocks[pos];
  if (!b) return null;
  const rest = pos < blocks.length - 1 ? "; the blocks after it did not run" : "";
  if (status !== 0) return `${blockLabel(b)} exited ${status}${rest}`;
  return `${blockLabel(b)} exited the shell${rest}`;
}
