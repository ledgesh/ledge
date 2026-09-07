// Subsequence matching for the quick-open palette (PLAN D12: command-palette
// style, not prefix or plain substring). Every query character must appear in
// order, but not adjacently: "shnt" finds "shipping-notes".
//
// Scoring considers every alignment, not just the leftmost. Greedy matching
// (take the first occurrence of each character) is cheaper but cannot rank:
// for "n" it stops at the n in "shipping" and scores "shipping-notes" no
// better than "shipping". The small dynamic program below, over (query char,
// text position), scores every alignment and keeps the best.
import type { NoteMeta } from "./channel";

// Characters that start a new word in a filename. A match just after one
// scores higher, as the n does in shipping-|notes.
const BOUNDARY = /[-_ /.]/;

const MATCH = 10; // the base score for a matched character
const AT_BOUNDARY = 8; // added when the match starts a word
const ADJACENT = 15; // added when the match continues an unbroken run
const MAX_GAP_PENALTY = 10; // the most one skip can cost, so a good match survives it
const NONE = -Infinity;

// What a match at `j` is worth on its own, before any link to the previous one.
function base(t: string, j: number): number {
  return MATCH + (j === 0 || BOUNDARY.test(t[j - 1]!) ? AT_BOUNDARY : 0);
}

// Score `text` against `query`, or null if it does not match at all. Higher is
// better. The scale is arbitrary: scores only rank the results of one query
// against each other.
export function fuzzyScore(query: string, text: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length > t.length) return null;

  // best[j] = the best score for matching the query so far with its last
  // character landing on text position j. Seeded at every position holding the
  // first query character, less how far into the name it sits (capped at
  // MAX_GAP_PENALTY).
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

// The command palette's boost for chorded commands. A chord marks a
// frequent act: chords are scarce and allocated by hand (interactions.md §2).
// The boost decides which of two comparable matches ranks first. "daily"
// puts ⌘J's Open Today's Daily Note above Edit Daily Template. It exceeds
// MAX_GAP_PENALTY, so it outweighs where in a title a match sits. A second
// adjacent character adds 25, so the boost never beats a tighter match.
export const CHORD_BOOST = 12;

// Anything matching `query`, best first, labelled by `key`. An empty query
// keeps every item and sorts by label. Ties break on the label, so the order
// is stable and never depends on the order the items arrived in. `boost` adds
// a per-item constant after match scoring: item importance, on the same
// arbitrary scale (the palette passes CHORD_BOOST for chorded commands only).
// It never revives a non-match.
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string,
  boost?: (item: T) => number,
): T[] {
  const q = query.trim();
  const scored: Array<{ item: T; score: number; label: string }> = [];
  for (const item of items) {
    const label = key(item);
    const score = fuzzyScore(q, label);
    if (score !== null) scored.push({ item, score: score + (boost?.(item) ?? 0), label });
  }
  scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored.map((s) => s.item);
}

// Filters `notes` by `query` for the quick-open palette, best match first.
export function filterNotes(query: string, notes: NoteMeta[]): NoteMeta[] {
  return fuzzyFilter(query, notes, (n) => n.title);
}
