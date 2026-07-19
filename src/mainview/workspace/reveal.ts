// Where to put the selection when a search hit opens its note — the pure core
// of the editor pool's reveal (testing.md §2: the decision is tested
// here; the dispatch that acts on it stays a thin wrapper in editorPool.ts).
//
// The hit's line number is a claim about the file at search time, and the file
// may have moved on (an edit, an autosave race). So the line is clamped, the
// query is re-found on it, and every miss degrades one step: no match on the
// line → its start; line gone → the last line. A reveal that lands nearby
// beats one that throws.
import type { Text } from "@codemirror/state";
import { atxHeading } from "../../shared/wikilinks";

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

/**
 * Where a `#heading` anchor lands: the first ATX heading whose text matches
 * (case-insensitive, whitespace-trimmed — the raw heading text, not its
 * slug). The grammar itself lives in shared/wikilinks.ts (atxHeading), where
 * the MCP server's heading-targeted append reads the SAME rule — the two
 * ends of [[note#heading]] must agree on what a heading is. Same degradation
 * stance as revealSelection: the anchor is a claim about the note, and a
 * note that has moved on gets the top of the document rather than a throw.
 * (Line-by-line, not fence-aware like headingsOf: a reveal that lands on a
 * fenced fake heading is a nearby miss, which is this module's failure mode
 * anyway.)
 */
export function revealHeading(doc: Text, heading: string): { anchor: number; head: number } {
  const want = heading.trim().toLowerCase();
  if (want !== "") {
    for (let i = 1; i <= doc.lines; i += 1) {
      const l = doc.line(i);
      const h = atxHeading(l.text);
      if (h && h.text.toLowerCase() === want) return { anchor: l.from, head: l.from };
    }
  }
  return { anchor: 0, head: 0 };
}
