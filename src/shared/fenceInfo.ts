// The code fence's info string: its language, and the attributes after it.
// CommonMark leaves everything after the language word free text, which is
// why a block's attributes are written there (interactions.md §4b).
//
// Attribute names this parse does not know are ignored, never reported.
// Other tools write in the same slot: `no_run` in mdBook, `title="…"` and
// `showLineNumbers` in Docusaurus, `{1,3}` for line-range highlighting. A
// note carried in from one of them has to keep running here.
//
// Ledge reads three attributes, decided by `confirmFor`, `noRun` and
// `blockName` below, which sit beside the grammar so one test covers the
// parse and the meaning. `confirm` (§4b) puts a modal between the run chord
// and execution. `norun` (§4e) takes the run verbs off a block that is in the
// note to be read or copied, such as an install step for another machine.
// Without the mark such a block shows a live run button aimed at wherever this
// note's shell is, which is why every fence in a runnable language in the
// manual carries it (writing.md §10). `name` is how `ledge run -b` addresses
// one block (interactions.md §9).
//
// The module is shared because both ends read fences: the view to draw run
// controls, the CLI to run blocks from a shell (shared/codeBlocks.ts).

/** A fence opener's language and attributes. */
export interface FenceInfo {
  // The first word of the info string: "sh" from ```sh, null when absent.
  lang: string | null;
  // Everything after it, keyed by lower-cased name. A bare flag maps to "".
  // A repeated name replaces the earlier one, as it does in the frontmatter
  // parser.
  attrs: Map<string, string>;
}

/** What a block's confirm marker asks for. `message` null = use the default. */
export interface ConfirmSpec {
  message: string | null;
}

// A fence opener line: leading spaces or tabs, 3+ marks, then the info
// string. OPEN_TICK and OPEN_TILDE below are narrower, for deciding whether a
// line is an opener at all: they split the two mark characters, allow at most
// three spaces of indent, and OPEN_TICK rejects a backtick inside the info.
// Blocks reach parseFenceInfo already parsed as FencedCode.
const OPENER = /^[ \t]*(?:`{3,}|~{3,})(.*)$/;

// A code-fence opener per CommonMark: up to 3 spaces of indent, then ``` or
// ~~~ (3+ marks), then an info string. A backtick fence's info string may not
// contain a backtick (` ```js`` ` is not a fence).
const OPEN_TICK = /^( {0,3})(`{3,})([^`]*)$/;
const OPEN_TILDE = /^( {0,3})(~{3,})(.*)$/;

/**
 * The line's code-fence opener shape (its indent and its fence marks), or
 * null. Pure, so the grammar is testable line by line.
 */
export function fenceOpener(lineText: string): { indent: string; marker: string } | null {
  const m = OPEN_TICK.exec(lineText) ?? OPEN_TILDE.exec(lineText);
  return m ? { indent: m[1]!, marker: m[2]! } : null;
}

/**
 * Whether a line closes a fence opened with `marker`: the same character, at
 * least as many of them, nothing but blanks after (a close fence carries no
 * info string).
 */
export function fenceCloser(lineText: string, marker: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(lineText);
  return !!m && m[1]![0] === marker[0] && m[1]!.length >= marker.length;
}

// An attribute name: a letter, then letters/digits/-/_. A name that fails
// this is another tool's syntax (`{1,3}`, `:::`) and is dropped in silence.
const ATTR_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

// Values spelling "off" and "on". Compared after quote stripping, so what a
// value means does not depend on how it was punctuated: `confirm=no` and
// `confirm="no"` are the same.
const OFF = new Set(["no", "false", "off", "0"]);
const ON = new Set(["", "yes", "true", "on", "1"]);

/**
 * Split an info string's tail into tokens, honouring quotes so a value may
 * carry spaces: `confirm="Wipe the cache?"` is one token. Quotes are dropped
 * as they are consumed. An unterminated quote closes at end of line, so a
 * typo costs the quote rather than the whole attribute.
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
  // The language keeps its case (`SQL` is a fence people write) but never
  // contains an "=". A first token shaped like an attribute means the fence
  // named no language, so that token stays in the attribute list. Promoted to
  // `lang` it could turn a word nobody wrote into a runnable one: blocks.ts
  // reads `lang` with `norun` to decide whether a block gets run verbs.
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
 * `noteDefault` is the note's frontmatter `confirm:`, the whole-note stance of
 * interactions.md §4b. The per-block attribute wins over it either way:
 * `confirm=no` opts the one harmless block out, `confirm` marks the one
 * dangerous block in. A value that is not an on/off word becomes the dialog's
 * question, passed through as it was written, so the on/off vocabulary stays
 * small and closed.
 */
export function confirmFor(attrs: Map<string, string>, noteDefault: boolean): ConfirmSpec | null {
  const raw = attrs.get("confirm");
  if (raw === undefined) return noteDefault ? { message: null } : null;
  const value = raw.trim();
  if (OFF.has(value.toLowerCase())) return null;
  if (ON.has(value.toLowerCase())) return { message: null };
  return { message: value };
}

/**
 * Whether the fence is marked `norun`: no run pair on the card, and the chords
 * answer with a notice rather than executing (interactions.md §4e). The copy
 * button stays. Per block only, with no note-wide form: a note where no block
 * should run is a note without runnable languages. `norun=no` is the off
 * switch, matching `confirm`. Any other value leaves the mark in force: a
 * stray word is more likely a typo'd yes than a no.
 */
export function noRun(attrs: Map<string, string>): boolean {
  const raw = attrs.get("norun");
  if (raw === undefined) return false;
  return !OFF.has(raw.trim().toLowerCase());
}

/**
 * The block's `name` attribute, or null when it has none. `ledge run -b
 * <name>` addresses a block by it. A bare `name` or an empty value names
 * nothing. The value keeps its case and is matched case-insensitively.
 */
export function blockName(attrs: Map<string, string>): string | null {
  const raw = attrs.get("name")?.trim();
  return raw ? raw : null;
}
