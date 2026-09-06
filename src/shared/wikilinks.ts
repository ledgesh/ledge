// The pure half of wikilinks: what a `[[...]]` target means and which note a
// title names. The CodeMirror half (parse node, picker, click handling) is in
// mainview/editor/wikilinks.ts. These sit in shared/ because both ends must
// give the same answer: the view resolves links to draw and follow them, and
// Bun's MCP server resolves the same titles (read_note by title, backlinks).
// Same reasoning as shared/search.ts: one definition, not a pair that drifts.

/** What a store must say about a note before a title can resolve to it. */
export interface WikiNote {
  path: string;
  title: string;
}

/** A wikilink's inner text, split into the note title and the optional
 * `#heading` anchor. Null when there is no title to resolve (`[[#h]]`,
 * whitespace). Such a link always dangles. */
export function parseWikiTarget(raw: string): { title: string; heading: string | null } | null {
  const hash = raw.indexOf("#");
  const title = (hash < 0 ? raw : raw.slice(0, hash)).trim();
  if (!title) return null;
  const heading = hash < 0 ? null : raw.slice(hash + 1).trim();
  return { title, heading: heading || null };
}

/**
 * The note `title` names, or null. The match is exact and case-insensitive,
 * never fuzzy: opening the nearest title would follow a typo to the wrong
 * note, so a wrong title dangles instead. An exact-case match wins over a
 * case-folded one. Remaining ties go to the first in list order (newest mtime
 * first, as the store holds them).
 */
export function resolveWikiTitle<N extends WikiNote>(title: string, notes: readonly N[]): N | null {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  let folded: N | null = null;
  for (const n of notes) {
    const t = n.title.trim();
    if (t === title.trim()) return n;
    if (folded === null && t.toLowerCase() === want) folded = n;
  }
  return folded;
}

/** One wikilink occurrence in a note's text, located by 1-based line. `raw`
 * is the matched `[[...]]` text exactly as written. The backlinks panel's
 * reveal re-finds it on the line (workspace/reveal.ts revealSelection), so it
 * must be the file's own spelling, not a normalized reconstruction. */
export interface WikiRef {
  title: string;
  heading: string | null;
  line: number;
  raw: string;
}

// The editor grammar in one regex: `[[`, then at least one character that is
// not a bracket or newline, then `]]`. A lone `]` inside ends the match there
// too, because the grammar requires the first `]` to be the closer.
const WIKI_RE = /\[\[([^\[\]\n]+)\]\]/g;

/**
 * Every wikilink target in `text`, for backlink scans. Textual, not a full
 * markdown parse. Fenced code blocks are skipped, as the editor grammar skips
 * them: a fence holds pasted logs and code, whose brackets are not links.
 * Inline `code` spans are not skipped, so `[[x]]` in backticks counts here but
 * not in the editor. That imprecision only affects backlink navigation, so it
 * is not worth running a markdown parser on the Bun side.
 */
export function wikiRefsOf(text: string): WikiRef[] {
  const out: WikiRef[] = [];
  for (const { line, i } of contentLines(text.split("\n"))) {
    for (const m of line.matchAll(WIKI_RE)) {
      const parsed = parseWikiTarget(m[1]!);
      if (parsed) out.push({ ...parsed, line: i + 1, raw: m[0] });
    }
  }
  return out;
}

// The fence walk every textual scanner here shares. A fenced block spans its
// delimiters inclusive. An open fence closes only on a fence line of the same
// character, at least as long, with nothing after it (CommonMark's rule). Any
// other fence-ish line inside is content of the fence, and an unclosed fence
// runs to the last line.
interface FenceSpan {
  from: number; // 0-based line of the opening fence
  to: number; // 0-based line of the closing fence (or the last line, unclosed)
  // The opening line's info string. "prompt" marks a runnable prompt fence.
  info: string;
}

function fenceSpans(lines: readonly string[]): FenceSpan[] {
  const out: FenceSpan[] = [];
  let open: { ch: string; len: number; from: number; info: string } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    if (!f) continue;
    const ch = f[1]![0]!;
    if (open === null) open = { ch, len: f[1]!.length, from: i, info: f[2]!.trim() };
    else if (ch === open.ch && f[1]!.length >= open.len && f[2]!.trim() === "") {
      out.push({ from: open.from, to: i, info: open.info });
      open = null;
    }
  }
  if (open) out.push({ from: open.from, to: lines.length - 1, info: open.info });
  return out;
}

/** Yields only the content lines, everything outside every fence span.
 * Exported for shared/tags.ts, whose inline `#tag` scan skips fenced code by
 * this same walk rather than by a second copy that could drift. */
export function* contentLines(lines: readonly string[]): Generator<{ line: string; i: number }> {
  const spans = fenceSpans(lines);
  let s = 0;
  for (let i = 0; i < lines.length; i += 1) {
    while (s < spans.length && spans[s]!.to < i) s += 1;
    const sp = spans[s];
    if (sp && i >= sp.from && i <= sp.to) continue;
    yield { line: lines[i]!, i };
  }
}

// --- headings ---------------------------------------------------------------
// The `#heading` half of the wikilink grammar, shared for the same reason as
// the title half. The view reveals [[note#heading]] anchors
// (workspace/reveal.ts) and the MCP server appends under them (append_note's
// `heading`). Both must agree on what counts as a heading.

// An ATX heading line: `## Title`, with an optional closing run of #s. Setext
// headings do not count, and that is the rule rather than a gap to fill in:
// people type headings while looking at rendered notes, where Ledge's own
// headings are ATX.
const ATX_LINE = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;

/** The heading a line carries, or null. Grammar only: the caller handles
 * fence context (headingsOf is the fence-aware scan). */
export function atxHeading(line: string): { level: number; text: string } | null {
  const m = ATX_LINE.exec(line);
  return m ? { level: m[1]!.length, text: m[2]!.trim() } : null;
}

/** One heading in a note, located by 1-based line. */
export interface NoteHeading {
  text: string;
  level: number;
  line: number;
}

/** Every heading in `text`, in document order. The scan is fence-aware, so a
 * `# comment` inside a code block is neither a target nor a section
 * boundary. */
export function headingsOf(text: string): NoteHeading[] {
  const out: NoteHeading[] = [];
  for (const { line, i } of contentLines(text.split("\n"))) {
    const h = atxHeading(line);
    if (h) out.push({ ...h, line: i + 1 });
  }
  return out;
}

/**
 * `text` with `addition` appended, at the end of the note or (given a
 * `heading`) at the end of that heading's section. A section runs to the next
 * heading of the same or shallower level, so appending under `## Sub` stays
 * inside it while appending under `# Top` lands after all of Top's
 * subsections. Null when a heading was named and none matches
 * (case-insensitive, whitespace-trimmed, first match wins: the same rule the
 * reveal anchor uses). A trailing run of ```prompt blocks stays last, so the
 * addition lands above it, and after every other fence (architecture.md §1).
 * One blank line separates the addition from what comes before and after it,
 * and a run of section-trailing blanks collapses to that. The caller strips
 * `addition`'s leading blank lines and trailing whitespace first (the MCP
 * handler does), or the separator doubles.
 */
export function appendToNote(text: string, addition: string, heading: string | null = null): string | null {
  const lines = text.split("\n");
  const spans = fenceSpans(lines);

  let secStart = 0;
  let secEnd = lines.length;
  if (heading !== null) {
    const want = heading.trim().toLowerCase();
    if (want === "") return null;
    const all = headingsOf(text);
    const target = all.find((h) => h.text.toLowerCase() === want);
    if (!target) return null;
    const next = all.find((h) => h.line > target.line && h.level <= target.level);
    secStart = target.line - 1;
    secEnd = next ? next.line - 1 : lines.length;
  }

  // Walk back from the section end: over blank lines, then over any whole
  // ```prompt block sitting there, until real content (or the section's
  // start). `boundary` ends up at the first line of the trailing prompt run.
  let boundary = secEnd;
  for (;;) {
    let i = boundary - 1;
    while (i >= secStart && lines[i]!.trim() === "") i -= 1;
    const span = i >= secStart ? spans.find((s) => s.to === i && s.from >= secStart) : undefined;
    if (span && span.info.toLowerCase() === "prompt") {
      boundary = span.from;
      continue;
    }
    const head = lines.slice(0, i + 1);
    const tail = [...lines.slice(boundary, secEnd), ...lines.slice(secEnd)];
    const out = [...head, ...(head.length ? [""] : []), ...addition.split("\n"), "", ...tail];
    // The final "" (or the tail's own last line) terminates the file with
    // exactly one newline, however the original ended.
    return out.join("\n").replace(/\n*$/, "\n");
  }
}
