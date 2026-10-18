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

// A slug is at most 60 code points and at most 200 UTF-8 bytes. The longest
// name built from one is a save's temp file (".<slug>-2.md.tmp-<pid>-<n>",
// notes.ts writeNote), about 30 bytes more, and ext4 refuses a name over 255
// bytes. Hangul and kanji fit all 60; 4-byte letters stop at 50.
const MAX_SLUG = 60;
const MAX_SLUG_BYTES = 200;

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
// left. Everything outside Unicode letters, their combining marks and numbers
// becomes a separator: no dots, no slashes, no colons, no control characters,
// no leading dot. The result is NFC. This is the whole trust boundary for a
// name arriving from the view (architecture.md §2).
export function slugify(heading: string): string | null {
  // Fold accents off Latin letters ("Café" -> "cafe"), so a Latin heading
  // names an ASCII file. Other scripts keep their marks: が is not か, and a
  // Devanagari vowel sign is part of the word. NFC recomposes what NFD split.
  const folded = heading
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .toLowerCase()
    .normalize("NFC");
  // A mark with no letter before it goes with the separator it follows.
  const slug = folded.replace(/^\p{M}+|[^\p{L}\p{M}\p{N}]+\p{M}*/gu, "-").replace(/^-+|-+$/g, "");
  if (!slug) return null; // a heading of pure punctuation
  const chars = Array.from(slug);
  if (chars.length <= MAX_SLUG && utf8Length(slug) <= MAX_SLUG_BYTES) return slug;
  const cut = chars.slice(0, MAX_SLUG);
  while (utf8Length(cut.join("")) > MAX_SLUG_BYTES) cut.pop();
  // Never cut between a letter and its marks.
  while (cut.length > 0 && /\p{M}/u.test(chars[cut.length] ?? "")) cut.pop();
  // Truncate on a word boundary when one is near the end, so a long heading is
  // cut at "shipping-notes" rather than "shipping-note".
  const lastDash = cut.lastIndexOf("-");
  const trimmed = (lastDash >= cut.length / 2 ? cut.slice(0, lastDash) : cut).join("");
  return trimmed.replace(/-+$/, "") || null;
}

const utf8 = new TextEncoder();
function utf8Length(s: string): number {
  return utf8.encode(s).length;
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
