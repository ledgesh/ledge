// The code fence's info string: its language, and the attributes after it.
//
// CommonMark says the info string is the language followed by arbitrary text,
// and every renderer worth naming keeps highlighting the block off that first
// word alone. So the tail is free space that travels with the block: a fence
// written ```sh confirm still highlights as sh on GitHub, in Obsidian, and in
// any editor the note is opened in, and the marker survives copy/paste of the
// block in a way an HTML comment above it would not.
//
// The parse is deliberately forgiving in one direction: attribute names it
// does not know are IGNORED, never reported. The same slot is where mdBook
// writes `no_run`, Docusaurus writes `title="…"` and `showLineNumbers`, and
// line-range highlighters write `{1,3}`. A note carried in from any of those
// must not start refusing to run because a word here was not ours.
//
// The one attribute Ledge reads today is `confirm` (interactions.md §4b): a
// modal stands between the run chord and execution. `confirmFor` below is the
// whole policy, kept here beside the grammar so the parse and the meaning are
// tested together.

/** A fence opener's language and attributes. */
export interface FenceInfo {
  // The first word of the info string: "sh" from ```sh, null when absent.
  lang: string | null;
  // Everything after it, keyed by lower-cased name. A bare flag maps to "".
  // A repeated name replaces, the frontmatter parser's last-wins rule.
  attrs: Map<string, string>;
}

/** What a block's confirm marker asks for. `message` null = use the default. */
export interface ConfirmSpec {
  message: string | null;
}

// A fence opener line: up to 3 spaces of indent, 3+ marks, then the info
// string. Duplicated in shape (not in job) from fences.ts's OPEN_TICK, which
// answers a different question — whether Enter should close the fence — and
// deliberately rejects backticks inside a backtick fence's info. Blocks here
// arrive already parsed as FencedCode, so the info is known good.
const OPENER = /^[ \t]*(?:`{3,}|~{3,})(.*)$/;

// An attribute name: a letter, then letters/digits/-/_. Anything failing this
// is another tool's syntax (`{1,3}`, `:::`) and is skipped in silence.
const ATTR_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

// Values spelling "off" and "on". Compared after quote stripping, so
// `confirm=no` and `confirm="no"` mean the same thing: what a value MEANS
// must not depend on how it was punctuated.
const OFF = new Set(["no", "false", "off", "0"]);
const ON = new Set(["", "yes", "true", "on", "1"]);

/**
 * Split an info string's tail into tokens, honouring quotes so a value may
 * carry spaces: `confirm="Wipe the cache?"` is ONE token. Quotes are dropped
 * as they are consumed, and an unterminated one closes at end of line rather
 * than losing the token — a typo costs the quote, not the attribute.
 */
function tokenize(tail: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: string | null = null;
  for (const ch of tail) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true; // `title=""` is a token, empty value and all
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** Parse a fence opener line. A line that is not one yields an empty info. */
export function parseFenceInfo(lineText: string): FenceInfo {
  const attrs = new Map<string, string>();
  const m = OPENER.exec(lineText);
  if (!m) return { lang: null, attrs };
  const tokens = tokenize(m[1]!);
  // The language keeps its case (`SQL` is a fence people write) but never an
  // "=": a first token shaped like an attribute means the fence named no
  // language at all, so it stays in the attribute list rather than becoming a
  // runnable word nobody wrote.
  const first = tokens[0] !== undefined && !tokens[0].includes("=") ? tokens.shift()! : null;
  for (const token of tokens) {
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (!ATTR_NAME.test(name)) continue;
    attrs.set(name.toLowerCase(), eq === -1 ? "" : token.slice(eq + 1));
  }
  return { lang: first, attrs };
}

/**
 * Whether this block runs behind a confirmation, and what it should ask.
 *
 * `noteDefault` is the note's frontmatter `confirm:` — a whole-note stance for
 * a runbook where every block deserves the pause. The per-block attribute wins
 * either way, so `confirm=no` is the escape hatch for the one harmless block
 * in such a note, and `confirm` marks the one dangerous block everywhere else.
 *
 * Any value that is not an on/off word is taken as the QUESTION to ask, which
 * is why the on/off vocabulary is small and closed: `confirm="Delete the
 * production cache?"` must not need punctuation lessons to work.
 */
export function confirmFor(attrs: Map<string, string>, noteDefault: boolean): ConfirmSpec | null {
  const raw = attrs.get("confirm");
  if (raw === undefined) return noteDefault ? { message: null } : null;
  const value = raw.trim();
  if (OFF.has(value.toLowerCase())) return null;
  if (ON.has(value.toLowerCase())) return { message: null };
  return { message: value };
}
