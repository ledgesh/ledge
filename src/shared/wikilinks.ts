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

/** One wikilink occurrence in a note's text, located by 1-based line. */
export interface WikiRef {
  title: string;
  heading: string | null;
  line: number;
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
  const lines = text.split("\n");
  // An open fence closes only on a fence line of the same character, at least
  // as long, with nothing after it (CommonMark's rule); any other fence-ish
  // line inside is content.
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      const ch = f[1]![0]!;
      if (fence === null) {
        fence = { ch, len: f[1]!.length };
        continue;
      }
      if (ch === fence.ch && f[1]!.length >= fence.len && f[2]!.trim() === "") fence = null;
      continue;
    }
    if (fence) continue;
    for (const m of line.matchAll(WIKI_RE)) {
      const parsed = parseWikiTarget(m[1]!);
      if (parsed) out.push({ ...parsed, line: i + 1 });
    }
  }
  return out;
}
