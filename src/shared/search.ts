// Full-text search over note bodies — the matcher behind the noteSearch RPC,
// and the cross-note counterpart of the editor's ⌘F.
//
// The grammar is deliberately the plainest thing a search box can promise: the
// whole query, trimmed, as ONE case-insensitive substring. No fuzziness — the
// subsequence scoring in mainview/notes/fuzzy.ts is right for titles, where
// every item is a short name, and wrong for bodies, where "shnt" aligning
// across a paragraph is noise no ranking can rescue. A substring either
// matches or it does not, which is the promise a body search actually makes.
//
// Lives in shared/, not bun/, because the matcher is contract rather than
// plumbing: Bun executes it over the files it owns (bun/notes.ts searchNotes),
// and the e2e harness's fake store must mirror the real store's semantics
// exactly (docs/testing.md §5) — one definition instead of a mirrored pair
// that drifts.

/** One matched line, carrying the note it lives in (the NoteMeta fields ride
 * along flat so a hit is self-sufficient: enough to list, open, and reveal). */
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

/** A matched line before it knows which note it belongs to. */
export interface LineHit {
  line: number;
  snippet: string;
  col: number;
}

// Caps, so one pasted log file cannot drown the list (per note) and the
// payload stays a result list rather than a corpus (total). Both are visible
// truncation: the overlay shows what made the cut, newest notes first.
export const MAX_HITS_PER_NOTE = 5;
export const MAX_HITS = 100;

// A snippet is one result row, not a paragraph: window long lines around the
// match, keeping a little context ahead of it so the match reads in place.
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
// per line (the first occurrence stands for the line — a second one on the
// same line adds a row without adding information).
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

/** What a store must say about a note before its text is worth reading. */
export interface NoteRef {
  path: string;
  title: string;
  mtimeMs: number;
}

// Search every note, newest text read lazily: `notes` arrives in the rank
// order results keep (both stores hand it over newest-first, the same order
// the sidebar shows), and reading stops once MAX_HITS is reached, so a query
// that saturates on recent notes never reads the old ones at all. `readText`
// returning null (a note deleted mid-search) costs that note and nothing else.
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
