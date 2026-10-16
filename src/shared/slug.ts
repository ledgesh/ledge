// A note's filename comes from its first-line H1.
//
// Shared because both ends must agree. Bun names the file: it owns the
// filesystem, and it slugs the heading itself rather than trusting a name the
// view computed. The view runs the same function to notice when a note's
// heading has changed enough to be worth renaming for.
//
// This reverses PLAN D15, which fixed filenames at creation because renaming a
// file under an open tab or a running shell is a footgun. The footgun is real.
// Renaming is safe only while a note's identity is its docId and not its path
// (architecture.md §4).

// At most 60 Unicode code points (240 UTF-8 bytes), leaving room under the
// 255-byte filename limit for an enumerated suffix and the extension.
const MAX_SLUG = 60;

// Far longer than any real heading, short enough that a runaway one cannot
// bloat the store. Only the on-screen label is capped; the note's text is
// untouched.
const MAX_LABEL = 120;

import { frontmatterEnd } from "./frontmatter";

// The note's title: the content of a first-line H1, or null if the note does
// not open with one. Strictly the first line and strictly one "#": a note that
// opens with prose, a list, or an "##" subheading has no title to take a name
// from.
//
// Frontmatter is the exception to the first-line rule. The title is the first
// line after the block, or every note carrying params would slug to
// "untitled". Blank lines are skipped there, and only there: leaving one under
// the closing fence is the convention in every frontmatter-bearing tool. A
// bare note keeps the strict rule, where a leading blank line is the signal
// that the note starts with something else.
export function headingOf(text: string): string | null {
  const start = frontmatterEnd(text);
  const body = start === 0 ? text : text.slice(start).replace(/^(?:[ \t]*\r?\n)+/, "");
  const nl = body.indexOf("\n");
  const firstLine = nl === -1 ? body : body.slice(0, nl);
  // CommonMark wants whitespace after the #, so "#hashtag" is not a heading.
  const m = /^#[ \t]+(.*\S)/.exec(firstLine);
  return m ? m[1]!.trim() : null;
}

// Turns a heading into a filesystem-safe slug, or null if nothing usable is
// left. Everything outside Unicode letters and numbers becomes a separator:
// no dots, no slashes, no colons, no control characters, no leading dot.
// This is the whole trust boundary for a name arriving from the view
// (architecture.md §2).
export function slugify(heading: string): string | null {
  // Fold accents first ("Café" -> "cafe"). Otherwise each accented letter
  // becomes a separator and breaks the word into pieces.
  // Recompose Hangul after folding so filenames keep syllables, not jamo.
  const folded = heading.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
  const slug = folded
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return null; // a heading of pure punctuation
  const characters = Array.from(slug);
  if (characters.length <= MAX_SLUG) return slug;
  // Truncate on a word boundary when one is near the end, so a long heading is
  // cut at "shipping-notes" rather than "shipping-note".
  const cut = characters.slice(0, MAX_SLUG);
  const lastDash = cut.lastIndexOf("-");
  const trimmed = (lastDash >= MAX_SLUG / 2 ? cut.slice(0, lastDash) : cut).join("");
  return trimmed.replace(/-+$/, "");
}

// The slug for a note's text, or null if it has no usable first-line H1. A note
// with no slug keeps the enumerated "untitled" name it was created with.
export function slugOf(text: string): string | null {
  const heading = headingOf(text);
  return heading === null ? null : slugify(heading);
}

// A note's filename without its extension: shipping-notes.md -> shipping-notes.
export function titleOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

// What to call a note on screen: its heading, else its filename, else
// "Untitled". Deleting a note's H1 does not rename its file (see syncTitle in
// notes/store.ts), so shipping-notes.md really is still "shipping-notes".
// "Untitled" would be wrong there, and it would read the same for every note
// that lost its heading. Only a note with no file and no heading has nothing
// left to be called.
export function labelOf(heading: string | null, path: string | null): string {
  if (heading === null) return path ? titleOf(path) : "Untitled";
  // A heading is a whole line, and nothing stops it being a paragraph. The tab
  // and the browser row truncate it visually, but there is no reason to carry
  // kilobytes of it through the store to be clipped by CSS.
  return heading.length > MAX_LABEL ? `${heading.slice(0, MAX_LABEL).trimEnd()}...` : heading;
}
