// A note's filename comes from its first-line H1.
//
// Shared because both ends need it and they must agree: Bun names the file (it
// owns the filesystem, and it slugs the heading itself rather than trusting a
// name the view computed), while the view uses the same function to notice when
// a note's heading has changed enough to be worth renaming for.
//
// This reverses PLAN D15, which fixed filenames at creation on the grounds that
// renaming files out from under open tabs and shells is a footgun. The footgun is
// real; what defuses it is that a note's identity is its docId, not its path, so
// the file can move without disturbing the editor, the undo history, or the
// shell running inside the note.

// Long enough for a real heading, short enough to stay clear of the 255-byte
// limit every filesystem here shares, with room for a "-2" suffix and the
// extension.
const MAX_SLUG = 60;

// Far longer than any real heading, short enough that a runaway one cannot bloat
// the store. Only the on-screen label is capped; the note's text is untouched.
const MAX_LABEL = 120;

import { frontmatterEnd } from "./frontmatter";

// The note's title: the content of a first-line H1, or null if the note does not
// open with one. Strictly the first line, and strictly one "#": a note that opens
// with prose, a list, or an "##" subheading has no title to take a name from.
//
// A frontmatter block does not count as the note opening with something else:
// the title is the first line AFTER it, else every note carrying params would
// slug to "untitled". Blank lines are skipped there — and only there. Leaving
// one under the closing fence is convention in every frontmatter-bearing tool,
// and honoring the strict-first-line rule against it would tax exactly the
// habit users arrive with; a bare note keeps the strict rule because there the
// blank line is the whole signal that the note starts with something else.
export function headingOf(text: string): string | null {
  const start = frontmatterEnd(text);
  const body = start === 0 ? text : text.slice(start).replace(/^(?:[ \t]*\r?\n)+/, "");
  const nl = body.indexOf("\n");
  const firstLine = nl === -1 ? body : body.slice(0, nl);
  // CommonMark wants whitespace after the #, so "#hashtag" is not a heading.
  const m = /^#[ \t]+(.*\S)/.exec(firstLine);
  return m ? m[1]!.trim() : null;
}

// Turn a heading into a filesystem-safe slug, or null if nothing usable is left.
// Everything outside [a-z0-9] becomes a separator, which makes the result safe by
// construction: no dots, no slashes, no colons, no control characters, no leading
// dot. That is the whole trust boundary for a name arriving from the view.
export function slugify(heading: string): string | null {
  // Fold accents first ("Café" -> "cafe") rather than letting them become
  // separators and shred the word.
  const folded = heading.normalize("NFD").replace(/\p{M}/gu, "");
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return null; // a heading of pure punctuation or non-latin script
  if (slug.length <= MAX_SLUG) return slug;
  // Truncate on a word boundary when one is near the end, so a long heading is
  // cut at "shipping-notes" rather than "shipping-note".
  const cut = slug.slice(0, MAX_SLUG);
  const lastDash = cut.lastIndexOf("-");
  const trimmed = lastDash >= MAX_SLUG / 2 ? cut.slice(0, lastDash) : cut;
  return trimmed.replace(/-+$/, "");
}

// The slug a note's text asks for, or null if it has no usable first-line H1 (in
// which case the note keeps the enumerated "untitled" name it was created with).
export function slugOf(text: string): string | null {
  const heading = headingOf(text);
  return heading === null ? null : slugify(heading);
}

// A note's filename without its extension: shipping-notes.md -> shipping-notes.
export function titleOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

// What to call a note on screen: its heading, else its filename.
//
// Falling back to the filename rather than to "Untitled" is the honest choice.
// Deleting a note's H1 does not rename its file (see syncTitle in notes/store.ts),
// so shipping-notes.md really is still "shipping-notes", and saying so beats
// showing a label that is both wrong and identical for every de-titled note. Only
// a note with no file AND no heading has nothing left to be called.
export function labelOf(heading: string | null, path: string | null): string {
  if (heading === null) return path ? titleOf(path) : "Untitled";
  // A heading is a whole line, and nothing stops it being a paragraph. The tab and
  // the browser row both truncate visually, but there is no reason to carry
  // kilobytes of it through the store to be clipped by CSS.
  return heading.length > MAX_LABEL ? `${heading.slice(0, MAX_LABEL).trimEnd()}...` : heading;
}
