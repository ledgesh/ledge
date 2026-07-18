// The pure half of wikilinks: what a `[[...]]` target means and which note a
// title names. The CodeMirror half — the parse node, the picker, the click
// handling — stays in mainview/editor/wikilinks.ts; these functions sit in
// shared/ because both ends need the SAME answer: the view resolves links to
// draw and follow them, and Bun's MCP server resolves the very same titles for
// agents (read_note by title, backlinks). Same reasoning as shared/search.ts —
// one definition instead of a mirrored pair that drifts.

/** What a store must say about a note before a title can resolve to it. */
export interface WikiNote {
  path: string;
  title: string;
}

/** A wikilink's inner text, split into the note title and the optional
 * `#heading` anchor. Null when there is no title to resolve (`[[#h]]`,
 * whitespace) — such a link is dangling by construction. */
export function parseWikiTarget(raw: string): { title: string; heading: string | null } | null {
  const hash = raw.indexOf("#");
  const title = (hash < 0 ? raw : raw.slice(0, hash)).trim();
  if (!title) return null;
  const heading = hash < 0 ? null : raw.slice(hash + 1).trim();
  return { title, heading: heading || null };
}

/**
 * The note `title` names, or null. Case-insensitive exact match — not fuzzy:
 * a link that silently opened the *nearest* title would follow typos to the
 * wrong note, and dangling-when-wrong is the honest failure. An exact-case
 * match wins over a case-folded one; remaining ties go to the first in list
 * order (newest mtime first, as the store holds them).
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
 * is the matched `[[...]]` text exactly as written — the backlinks panel's
 * reveal re-finds it on the line (workspace/reveal.ts revealSelection), so it
 * must be the file's own spelling, not a normalized reconstruction. */
export interface WikiRef {
  title: string;
  heading: string | null;
  line: number;
  raw: string;
}

// The editor grammar in one regex: `[[` then at least one character that is
// not a bracket or newline, then `]]` — a lone `]` inside aborts the link
// there too (the grammar requires the first `]` to be the closer).
const WIKI_RE = /\[\[([^\[\]\n]+)\]\]/g;

/**
 * Every wikilink target in `text`, for backlink scans. Textual, not a full
 * markdown parse: fenced code blocks are skipped (a ``` fence is where pasted
 * logs and code live, and a bracketed pattern in them is not a link — the
 * editor grammar agrees), but inline `code` spans are not — a `[[x]]` inside
 * backticks counts here and not in the editor. Backlinks are advisory
 * navigation, and that sliver of imprecision is not worth running a markdown
 * parser Bun-side.
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

// The one fence walk every textual scanner here shares. A fenced block spans
// its delimiters inclusive; an open fence closes only on a fence line of the
// same character, at least as long, with nothing after it (CommonMark's
// rule); any other fence-ish line inside is content of the fence; an
// unclosed fence swallows to the end. `info` is the opening line's info
// string ("prompt" for a runnable prompt fence).
interface FenceSpan {
  from: number; // 0-based line of the opening fence
  to: number; // 0-based line of the closing fence (or the last line, unclosed)
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

/** Yields only the CONTENT lines — everything outside every fence span.
 * Exported for shared/tags.ts: the inline `#tag` scan skips fenced code by
 * the same walk as the wikilink scan, one definition instead of a drift. */
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
// the title half: the view reveals [[note#heading]] anchors (workspace/
// reveal.ts) and the MCP server appends under them (append_note's `heading`),
// and both must agree on what counts as a heading.

// An ATX heading line: `## Title`, with an optional closing run of #s. Setext
// headings are deliberately out — this grammar is typed by people looking at
// rendered notes, where ATX is what Ledge's own headings are.
const ATX_LINE = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;

/** The heading a line carries, or null. Grammar only — fence context is the
 * caller's problem (headingsOf is the fence-aware scan). */
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

/** Every heading in `text`, in document order — fence-aware, so a `# comment`
 * inside a code block is neither a target nor a section boundary. */
export function headingsOf(text: string): NoteHeading[] {
  const out: NoteHeading[] = [];
  for (const { line, i } of contentLines(text.split("\n"))) {
    const h = atxHeading(line);
    if (h) out.push({ ...h, line: i + 1 });
  }
  return out;
}

/**
 * `text` with `addition` appended — at the end of the note, or (given a
 * `heading`) at the end of that heading's section. Null only when a heading
 * was named and no heading matches (case-insensitive, whitespace-trimmed,
 * first match wins — the same rule the reveal anchor uses). A section runs
 * to the next heading of the same or shallower level, so appending under
 * `## Sub` stays inside it while appending under `# Top` lands after all of
 * Top's subsections.
 *
 * "The end" floats above trailing ```prompt blocks: a runnable prompt fence
 * at the end of a note (or section) is its control, not its content — the
 * user types an instruction there and runs it, possibly many times — and
 * appending BELOW it interleaves results with the button that produced them.
 * Additions land above the trailing run of prompt blocks; every other fence
 * (a ```sh snippet, say) is content and appends go after it as written.
 *
 * Block normalization: one blank line before the addition, one before
 * whatever follows, a run of section-trailing blanks collapsing to that.
 * `addition` is spliced as given — strip its leading blank lines and
 * trailing whitespace first (the MCP handler does), or the separator
 * doubles.
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
