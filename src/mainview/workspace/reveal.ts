// Where the selection goes when a search hit opens its note: the pure core of
// the editor pool's reveal, tested here. editorPool.ts queues the request and
// applies the result (testing.md §2). None of these functions throws. When the
// target is gone from the note, the result is a nearby position rather than an
// error.
import type { Text } from "@codemirror/state";
import { atxHeading } from "../../shared/wikilinks";

/**
 * Where a search hit's selection goes: `query`, found again on `line`. That
 * line number is where the match was when the search ran, and an edit or an
 * autosave race may have moved it since. A line past the end of the note
 * clamps to the last line. An empty `query`, or one the line no longer holds,
 * puts the caret at the line's start.
 */
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
 * Where a `#heading` anchor lands: the first ATX heading whose text equals
 * `heading`, ignoring case and surrounding whitespace. The comparison is on
 * the raw heading text, not a slug. shared/wikilinks.ts defines the grammar
 * (atxHeading), and appendToNote resolves append_note's `heading` argument
 * with it: both ends of `[[note#heading]]` must agree on what a heading is.
 * A heading the note no longer has returns the top of the document. This scan
 * is line by line, not fence-aware like headingsOf, so a `#` line inside a
 * fence can be the target. That is a nearby miss, accepted rather than fixed
 * (appendToNote, which is fence-aware, refuses the same anchor).
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

/**
 * Where the caret goes in a just-created note: inside the title, right after
 * the `# ` marker. The first keystroke then types into the H1, which is the
 * rename UI, instead of landing in front of the hash. The scan takes the first
 * ATX heading, not line 1, because a note made from a template can carry
 * frontmatter above its title. A note with no heading returns the top of the
 * document.
 *
 * `placeholder` says the title is a word the app made up ("Untitled") rather
 * than one it computed, such as a daily note's date. A made-up title is
 * selected, so typing the real name replaces it. A computed title gets the
 * caret alone, so a stray keystroke does not overwrite the date.
 */
export function revealTitle(doc: Text, placeholder = false): { anchor: number; head: number } {
  for (let i = 1; i <= doc.lines; i += 1) {
    const l = doc.line(i);
    if (!atxHeading(l.text)) continue;
    const at = l.from + (/^#{1,6}[ \t]+/.exec(l.text)?.[0].length ?? 0);
    return { anchor: at, head: placeholder ? l.to : at };
  }
  return { anchor: 0, head: 0 };
}
