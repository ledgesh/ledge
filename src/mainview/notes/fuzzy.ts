// Subsequence matching for the quick-open palette (PLAN D12: command-palette
// style, not prefix or plain substring). Every query character must appear in
// order, but not adjacently: "shnt" finds "shipping-notes".
//
// Scoring considers the BEST alignment, not the leftmost one. Greedy matching
// (walk the text taking the first occurrence of each character) is cheaper, but
// it cannot rank: for "n" against "shipping-notes" it locks onto the n in
// "shipping" and never sees the one starting "notes", so a clean word-boundary
// hit scores identically to a mid-word accident. A small dynamic program over
// (query char, text position) picks the alignment a human would.
import type { NoteMeta } from "./channel";

// Characters that start a new "word" in a filename, so a match just after one
// reads as intentional (the n in shipping-|notes).
const BOUNDARY = /[-_ /.]/;

const MATCH = 10; // every matched character is worth something
const AT_BOUNDARY = 8; // ...more if it starts a word
const ADJACENT = 15; // ...much more if it continues an unbroken run
const MAX_GAP_PENALTY = 10; // one big skip should not sink an otherwise good match
const NONE = -Infinity;

// What a match at `j` is worth on its own, before any link to the previous one.
function base(t: string, j: number): number {
  return MATCH + (j === 0 || BOUNDARY.test(t[j - 1]!) ? AT_BOUNDARY : 0);
}

// Score `text` against `query`, or null if it does not match at all. Higher is
// better; the scale is arbitrary and only meaningful for ranking one query's
// results against each other.
export function fuzzyScore(query: string, text: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length > t.length) return null;

  // best[j] = the best score for matching the query so far with its LAST
  // character landing on text position j. Seeded with the first query character,
  // penalised by how far into the name it sits.
  let best: number[] = new Array(t.length).fill(NONE);
  for (let j = 0; j < t.length; j += 1) {
    if (t[j] === q[0]) best[j] = base(t, j) - Math.min(j, MAX_GAP_PENALTY);
  }

  for (let i = 1; i < q.length; i += 1) {
    const next: number[] = new Array(t.length).fill(NONE);
    // Query char i cannot land before position i: the i chars before it need room.
    for (let j = i; j < t.length; j += 1) {
      if (t[j] !== q[i]) continue;
      let linked = NONE;
      for (let k = i - 1; k < j; k += 1) {
        if (best[k] === NONE) continue;
        // Continuing a run is worth far more than resuming after a gap.
        const link = j === k + 1 ? ADJACENT : -Math.min(j - k - 1, MAX_GAP_PENALTY);
        linked = Math.max(linked, best[k]! + link);
      }
      if (linked !== NONE) next[j] = linked + base(t, j);
    }
    best = next;
  }

  let top = NONE;
  for (const s of best) if (s > top) top = s;
  return top === NONE ? null : top;
}

// Notes matching `query`, best first. An empty query keeps every note and sorts
// by title, which is what the palette shows the moment it opens.
export function filterNotes(query: string, notes: NoteMeta[]): NoteMeta[] {
  const scored: Array<{ note: NoteMeta; score: number }> = [];
  for (const note of notes) {
    const score = fuzzyScore(query.trim(), note.title);
    if (score !== null) scored.push({ note, score });
  }
  // Ties break on title so the order is stable and never depends on the order
  // the notes happened to arrive in.
  scored.sort((a, b) => b.score - a.score || a.note.title.localeCompare(b.note.title));
  return scored.map((s) => s.note);
}
