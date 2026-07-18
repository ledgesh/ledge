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

// An ATX heading line and its text: `## Title` with an optional closing run
// of #s. Setext headings are deliberately out — the wikilink anchor grammar
// this serves ([[note#heading]], editor/wikilinks.ts) is typed by people
// looking at rendered notes, where ATX is what Ledge's own headings are.
const ATX_LINE = /^#{1,6}\s+(.+?)(?:\s+#+\s*)?$/;

/**
 * Where a `#heading` anchor lands: the first ATX heading whose text matches
 * (case-insensitive, whitespace-trimmed — the raw heading text, not its
 * slug). Same degradation stance as revealSelection: the anchor is a claim
 * about the note, and a note that has moved on gets the top of the document
 * rather than a throw.
 */
export function revealHeading(doc: Text, heading: string): { anchor: number; head: number } {
  const want = heading.trim().toLowerCase();
  if (want !== "") {
    for (let i = 1; i <= doc.lines; i += 1) {
      const l = doc.line(i);
      const m = ATX_LINE.exec(l.text);
      if (m && m[1]!.trim().toLowerCase() === want) return { anchor: l.from, head: l.from };
    }
  }
  return { anchor: 0, head: 0 };
}
