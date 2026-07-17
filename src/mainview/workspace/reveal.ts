// Where to put the selection when a search hit opens its note — the pure core
// of the editor pool's reveal (docs/testing.md §2: the decision is tested
// here; the dispatch that acts on it stays a thin wrapper in editorPool.ts).
//
// The hit's line number is a claim about the file at search time, and the file
// may have moved on (an edit, an autosave race). So the line is clamped, the
// query is re-found on it, and every miss degrades one step: no match on the
// line → its start; line gone → the last line. A reveal that lands nearby
// beats one that throws.
import type { Text } from "@codemirror/state";

export function revealSelection(
  doc: Text,
  line: number,
  query: string,
): { anchor: number; head: number } {
  const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
  const q = query.trim().toLowerCase();
  const col = q === "" ? -1 : l.text.toLowerCase().indexOf(q);
  if (col < 0) return { anchor: l.from, head: l.from };
  return { anchor: l.from + col, head: l.from + col + q.length };
}
