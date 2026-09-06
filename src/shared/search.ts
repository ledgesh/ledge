// Full-text search over note bodies: the matcher behind the noteSearch RPC,
// and the cross-note counterpart of the editor's ⌘F. Ledge matches the whole
// trimmed query as one case-insensitive substring. There is no fuzzy matching.
// The subsequence scoring in mainview/notes/fuzzy.ts suits titles, which are
// short names. It is wrong for bodies, where "shnt" aligning across a
// paragraph is noise no ranking can rescue.
//
// The matcher is contract rather than plumbing, so it lives in shared/, not
// bun/. Bun runs it over the files it owns (bun/notes.ts searchNotes), and the
// e2e harness's fake store must mirror the real store's semantics exactly
// (testing.md §5). One definition keeps the two from drifting.

/** One matched line plus the note it came from. The NoteMeta fields sit flat
 * on the hit, so a caller can list, open, and reveal it without a second
 * lookup. */
export interface SearchHit {
  path: string;
  title: string;
  mtimeMs: number;
  /** 1-based line the match sits on. */
  line: number;
  /** The matched line, windowed around the match when it is long. */
  snippet: string;
  /** Where the match starts within `snippet`. */
  col: number;
}

/** A matched line, without the note it came from. */
export interface LineHit {
  line: number;
  snippet: string;
  col: number;
}

// Caps on the result set. The per-note cap keeps one pasted log file from
// filling the list; the total cap keeps the payload a result list rather than
// a copy of the corpus. Both truncate visibly: the overlay shows what made the
// cut, newest notes first.
export const MAX_HITS_PER_NOTE = 5;
export const MAX_HITS = 100;

// A snippet fills one result row, so snip() windows a long line around the
// match. SNIPPET_LEAD keeps a little context before the match, so the match
// does not sit flush against the left edge of the row.
const SNIPPET_MAX = 160;
const SNIPPET_LEAD = 24;

function snip(line: string, col: number, len: number): { snippet: string; col: number } {
  // Leading indentation is markdown structure, not context worth a row's width.
  const trimmed = line.trimStart();
  col -= line.length - trimmed.length;
  if (trimmed.length <= SNIPPET_MAX) return { snippet: trimmed, col };
  const start = Math.max(0, Math.min(col - SNIPPET_LEAD, trimmed.length - SNIPPET_MAX));
  const end = Math.min(trimmed.length, start + SNIPPET_MAX);
  const head = start > 0 ? "…" : "";
  const tail = end < trimmed.length ? "…" : "";
  return { snippet: head + trimmed.slice(start, end) + tail, col: col - start + head.length };
}

// Every line of `text` matching `query`, in document order, at most one hit
// per line. Only the first occurrence on a line is reported: a second hit on
// the same line would add a row without adding information.
export function searchText(query: string, text: string, limit = MAX_HITS_PER_NOTE): LineHit[] {
  const q = query.trim().toLowerCase();
  if (q === "" || limit <= 0) return [];
  const out: LineHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i += 1) {
    const line = lines[i]!;
    const col = line.toLowerCase().indexOf(q);
    if (col < 0) continue;
    out.push({ line: i + 1, ...snip(line, col, q.length) });
  }
  return out;
}

/** The fields a store supplies for a note before collectHits reads its text. */
export interface NoteRef {
  path: string;
  title: string;
  mtimeMs: number;
}

// Search every note, reading a note's body only when the loop reaches it. The
// results keep the order of `notes`: both stores pass it newest-first, the
// order the sidebar shows. Reading stops at MAX_HITS, so a query that fills up
// on recent notes never reads the older ones. `readText` returning null (a
// note deleted mid-search) costs that note and nothing else.
export async function collectHits(
  query: string,
  notes: readonly NoteRef[],
  readText: (path: string) => string | null | Promise<string | null>,
): Promise<SearchHit[]> {
  if (query.trim() === "") return [];
  const out: SearchHit[] = [];
  for (const n of notes) {
    if (out.length >= MAX_HITS) break;
    const text = await readText(n.path);
    if (text === null) continue;
    const limit = Math.min(MAX_HITS_PER_NOTE, MAX_HITS - out.length);
    for (const h of searchText(query, text, limit)) {
      out.push({ path: n.path, title: n.title, mtimeMs: n.mtimeMs, ...h });
    }
  }
  return out;
}
